import {
  Context,
  Session,
  Logger,
  segment,
  Schema,
  h,
  Universal,
} from "koishi";
import { OneBotBot, OneBot } from "@koishijs/plugin-adapter-onebot";
import { DiscordBot } from "@koishijs/plugin-adapter-discord";
import {
  GuildMember,
  Role,
  snowflake,
} from "@satorijs/adapter-discord/lib/types";
import type { } from "@koishijs/plugin-adapter-onebot";
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

const logger = new Logger("relay");

export interface RelayTable {
  id: number;
  dcId: string;
  onebotId: string;
  deleted: number;
  message: string;
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

export const using = ["database"] as const;

export async function apply(ctx: Context, config: Config) {
  ctx.model.extend(
    "dcqq_relay",
    {
      id: "unsigned",
      dcId: "string",
      onebotId: "string",
      deleted: "integer",
      message: "text"
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

  validCtx.platform("discord").on("message-deleted", async (session) => {
    let [data] = await ctx.database.get("dcqq_relay", {
      dcId: [session.messageId],
      deleted: [0],
    });
    if (data) {
      data.deleted = 1;
      await ctx.database.upsert("dcqq_relay", [data]);
      const onebot = session.app.bots.find(
        (v) => v.platform === "onebot"
      ) as unknown as OneBotBot;
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
      data.deleted = 1;
      await ctx.database.upsert("dcqq_relay", [data]);
      const discordChannel = config.relations.find(
        (v) => v.onebotChannel === session.channelId
      );
      const dcBot = session.app.bots.find(
        (v) => v.platform === "discord"
      ) as unknown as DiscordBot;
      try {
        await dcBot.deleteMessage(discordChannel.discordChannel, data.dcId);
      } catch (e) {
        if (e.response?.data) {
          await session.send("删除 DC 消息失败: " + e.response.data.message);
        }
      }
      // if (discordChannel.discordLogChannel) {
      //   await dcBot.sendMessage(discordChannel.discordLogChannel, `[QQ:${session.userId}]撤回消息:\n${data[0].message}`)
      // }
    }
  });

  const adaptDiscordMessage = async (session: Session) => {
    const dcBot = session.bot as DiscordBot
    const msg = await dcBot.internal.getChannelMessage(
      session.channelId,
      session.messageId
    );
    let roles: Role[] = undefined;
    let members: Record<snowflake, GuildMember> = {};

    let result: segment = <message></message>;
    if (session.quote) {
      let quote = await ctx.database.get("dcqq_relay", {
        dcId: [session.quote.messageId],
      });
      if (quote.length) {
        result.children.push(segment.quote(quote[0].onebotId));
      }
    }

    let username;
    if (session.author.nickname !== session.author.username) {
      username = `${session.author.nickname}(${session.author.username}#${session.author.discriminator})`;
    } else {
      username = `${session.author.username}#${session.author.discriminator}`;
    }

    result.children.push(segment.text(`${username}: \n`));
    let tmp = await segment.transformAsync(session.elements, {
      face: (attrs) => (
        <image url={`https://cdn.discordapp.com/emojis/${attrs.id}`} />
      ),
      file: (attrs) => `[文件: ${attrs.file}](${attrs.url})`,
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
        const dcBot = session.bot;
        if (attrs.id) {
          let member =
            members[attrs.id] ||
            (await dcBot.internal.getGuildMember(session.guildId, attrs.id));
          members[attrs.id] = member;
          let username;

          if (member.nick && member.nick !== member.user.username) {
            username = `${member.nick}(${member.user.username}#${member.user.discriminator})`;
          } else {
            username = `${member.user.username}#${member.user.discriminator}`;
          }
          return `@${username} `;
        }
        if (attrs.role) {
          roles ||= await dcBot.internal.getGuildRoles(session.guildId);
          return `@[身份组]${roles.find((r) => r.id === attrs.role)?.name || "未知"
            } `;
        }
      },
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
    const onebot = ctx.bots.find(
      (v) => v.platform === "onebot"
    ) as unknown as OneBotBot;
    let [data] = await ctx.database.get("dcqq_relay", {
      dcId: [session.messageId],
      deleted: [0],
    });
    if (!data) return;
    const onebotChannel = config.relations.find(
      (v) => v.discordChannel === session.channelId
    ).onebotChannel;
    data.deleted = 1;
    await ctx.database.upsert("dcqq_relay", [data]);
    try {
      await onebot.deleteMessage("", data.onebotId);
    } catch (e) { }
    const msg = await adaptDiscordMessage(session);
    msg.children.push(segment.text("(edited)"));
    data.onebotId = (await onebot.sendMessage(onebotChannel, msg))[0];
    data.deleted = 0;
    await ctx.database.upsert("dcqq_relay", [data]);
  });

  validCtx.platform("discord").on("message", async (session) => {
    const relation = config.relations.find(
      (v) => v.discordChannel === session.channelId
    );
    const onebot = session.app.bots.find(
      (v) => v.platform === "onebot"
    ) as unknown as OneBotBot;
    const msg = await adaptDiscordMessage(session);
    let sent = await onebot.sendMessage(relation.onebotChannel, msg);
    for (const sentId of sent.filter((v) => v)) {
      await ctx.database.create("dcqq_relay", {
        onebotId: sentId,
        message: session.content,
        dcId: session.messageId,
      });
    }
  });

  validCtx.platform("onebot").on("message", async (session) => {
    const relation = config.relations.find(
      (v) => v.onebotChannel === session.channelId
    );
    const dcBot = ctx.bots.find(
      (v) => v.platform === "discord"
    ) as unknown as DiscordBot;
    const onebot = session.bot as OneBotBot;

    let result: segment = <message />;
    if (session.quote) {
      let [quote] = await ctx.database.get("dcqq_relay", {
        onebotId: [session.quote.messageId],
      });
      if (quote) {
        result.children.push(<quote id={quote.dcId} />);
      } else {
        logger.info("quote not found %o", session.quote);
      }
    }

    const sanity = (val: string) =>
      val
        .replace(/[\\*_`~|()]/g, "\\$&")
        .replace(/@everyone/g, () => "\\@everyone")
        .replace(/@here/g, () => "\\@here");
    let tmp = await segment.transformAsync(session.elements, {
      async at(attrs) {
        if (attrs.id === onebot.selfId) {
          return "";
        }

        let info = await onebot.getGuildMember(session.guildId, attrs.id);
        return `@[QQ: ${attrs.id}]${info.nickname || info.username} `;
      },
      async image(attrs) {
        if (attrs.type === "flash") {
          return "";
        }
        return segment.image(attrs.url);
      },
      async video(attrs) {
        return segment.video(attrs.url);
      },
      audio: '[语音]',
      face(attrs) {
        let alt = get(attrs.id);
        return alt ? `[${alt.QDes.slice(1)}]` : `[表情: ${attrs.id}]`;
      },
      async forward(attrs) {
        let data = await onebot.internal.getForwardMsg(attrs.id);
        let msgs: Universal.Message[] = [];
        for (const [i, v] of data.entries()) {
          const ses = dcBot.session();
          // @ts-ignore
          let { time, content, group_id, sender } = v;
          if (Array.isArray(content)) {
            content = "转发消息不处理";
          }
          let ob = await OneBot.adaptMessage(
            onebot,
            {
              time,
              message: content,
              message_type: "group",
              // @ts-ignore
              sender: {
                tiny_id: sender.user_id.toString(),
                user_id: sender.user_id,
                nickname: sender.nickname,
              },
              message_id: (group_id + time + sender.user_id + i) % 100000000,
            },
            ses
          );
          msgs.push(ob);
        }
        let tmp = (
          <message forward>
            {msgs.map(v => {
              let newElements = segment.transform(v.elements, {
                at: (attrs) => `@[QQ: ${attrs.id}]`,
                image(attrs) {
                  if (attrs.type === "flash") {
                    return "";
                  }
                  return segment.image(attrs.url);
                },
                video(attrs) {
                  return segment.video(attrs.url);
                },
                face(attrs) {
                  let alt = get(attrs.id);
                  return alt ? `[${alt.QDes.slice(1)}]` : `[表情: ${attrs.id}]`;
                }
              })
              return (
                <message>
                  <author
                    nickname={`[QQ: ${v.author.userId}] ${v.author.username}`}
                    avatar={v.author.avatar}
                  ></author>
                  {newElements}
                </message>
              );
            })}
          </message>
        );
        return tmp;
      },
    });
    result.children.push(
      <author
        nickname={`[QQ:${session.userId}] ${session.username}`}
        avatar={session.author.avatar}
      />
    );
    result.children = [...result.children, ...tmp];
    let sent = await dcBot.sendMessage(
      relation.discordChannel,
      result,
      relation.discordGuild
    );

    for (const sentId of sent) {
      await ctx.database.create("dcqq_relay", {
        onebotId: session.messageId,
        message: session.content,
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