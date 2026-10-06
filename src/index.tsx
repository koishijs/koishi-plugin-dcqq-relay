import { Bot, Context, Session, segment, Schema, Universal } from "koishi";
import type { DiscordBot } from "@koishijs/plugin-adapter-discord";
import type { GuildMember, Role, snowflake } from "@satorijs/adapter-discord/lib/types";
import { get } from "qface";

interface RelayRelation {
  discordChannel: string;
  discordGuild: string;
  forwardChannel: string;
  forwardPlatform: string;
  downloadAsset: boolean;
  showQQId: boolean;
  // discordLogChannel?: string;
  reverseName: boolean;
}

export interface Config {
  relations: RelayRelation[];
  recovery: string[];
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
      forwardChannel: Schema.string().required().description("转发的目标频道"),
      discordChannel: Schema.string().required(),
      discordGuild: Schema.string().required(),
      downloadAsset: Schema.boolean().default(false).description("本地下载资源后发送到目标平台"),
      showQQId: Schema.boolean().default(true).description("在 Discord 消息中显示用户 ID"),
      reverseName: Schema.boolean().default(false).description("优化发送顺序。有多媒体资源时，用户名在目标平台最后显示。（适用于 QQ）"),
    })
  ),
  recovery: Schema.array(String).default([]).description("进入恢复模式的 forwardPlatform。启动后积压这些平台相关的消息，直到执行 recovery 指令"),
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

  // messages deleted by the bot itself (sync delete / edit resend). Their message-deleted events
  // must be ignored, otherwise the deletion bounces back and removes the original message.
  let selfDeleted = new Set<string>()
  ctx.setInterval(() => {
    dcDeletedList = []
    selfDeleted = new Set()
  }, 1000 * 3600)

  const deleteBySelf = (bot: Bot, channelId: string, messageId: string) => {
    selfDeleted.add(`${bot.platform}:${channelId}:${messageId}`)
    return bot.deleteMessage(channelId, messageId)
  }
  const isSelfDeleted = (session: Session) => selfDeleted.has(`${session.platform}:${session.channelId}:${session.messageId}`)

  const RECOVERY_PREFIX = '[RECOVERY]'
  let recovering = false

  // per relation message queue, shared by both sides to keep the order. When the plugin starts with
  // the forward platform in recovery mode, new messages are held in memory until the recovery command
  // has synced the history of that relation, then relayed one by one.
  interface RelayQueue {
    ready: boolean
    ticket: number
    serving: number
  }
  const queues = new Map<RelayRelation, RelayQueue>()
  const getQueue = (relation: RelayRelation) => {
    let queue = queues.get(relation)
    if (!queue) queues.set(relation, queue = { ready: false, ticket: 0, serving: 0 })
    return queue
  }
  const isRecoveryRelation = (relation: RelayRelation) => config.recovery.includes(relation.forwardPlatform)
  const enqueue = async (relation: RelayRelation, task: () => Promise<void>) => {
    if (!isRecoveryRelation(relation)) return task()
    const queue = getQueue(relation)
    const ticket = queue.ticket++
    while (!queue.ready || queue.serving !== ticket) await ctx.sleep(100)
    try {
      await task()
    } finally {
      queue.serving++
    }
  }

  const isRelayed = async (session: Session) => {
    const rows = session.platform === "discord"
      ? await ctx.database.get("dcqq_relay", { dcId: [session.messageId!] })
      : await ctx.database.get("dcqq_relay", { forwardChannel: session.channelId, forwardId: [session.messageId!] })
    return rows.length > 0
  }

  const getBot = async (platform: string, channelId: string) => {
    const c = await ctx.database.getChannel(platform, channelId, ['assignee'])
    return ctx.bots[`${platform}:${c?.assignee}`]
  }

  // messages in ascending order, created at or after `begin`
  const getHistory = async (bot: Bot, channelId: string, begin: number) => {
    const messages: Universal.Message[] = []
    let next: string | undefined
    while (true) {
      logger.info("fetch history of %s:%s, next %s", bot.platform, channelId, next)
      // data is in ascending order, `next` is the cursor to older messages
      const page = await bot.getMessageList(channelId, next, 'before', 100)
      if (!page.data.length) break
      messages.unshift(...page.data.filter((v) => v.createdAt >= begin))
      if (page.data[0].createdAt < begin || !page.next || page.next === next) break
      next = page.next
    }
    return messages
  }

  const toUTC8String = (ts: number) => new Date(ts + 8 * 60 * 60 * 1000).toISOString().replace('Z', '+08:00')

  const markDeleted = async (rows: RelayTable[]) => {
    if (rows.length) {
      await ctx.database.set("dcqq_relay", { id: rows.map((v) => v.id) }, { deleted: 1 })
    }
    return rows
  }

  validCtx.platform("discord").on("message-deleted", async (session) => {
    if (isRecoveryRelation(getRelation(session))) return
    if (isSelfDeleted(session)) return
    const rows = await markDeleted(await ctx.database.get("dcqq_relay", {
      dcId: [session.messageId!],
      deleted: [0],
    }));
    if (!rows.length) return
    dcDeletedList.push(session.messageId!)
    const relation = getRelation(session)
    const c = await ctx.database.getChannel(relation.forwardPlatform, relation.forwardChannel, ['assignee'])
    const forwardBot = ctx.bots[`${relation.forwardPlatform}:${c.assignee}`]
    for (const data of rows) {
      try {
        await deleteBySelf(forwardBot, data.forwardChannel, data.forwardId);
      } catch (e) {
        logger.error("delete forward message failed, dc channel id %s, message id %s, forward channel %s, forward message id %s", session.channelId, session.messageId, data.forwardChannel, data.forwardId)
        logger.error(e)
      }
    }
  });
  validCtx.intersect(v => v.platform !== "discord").on("message-deleted", async (session) => {
    if (isRecoveryRelation(getRelation(session))) return
    if (isSelfDeleted(session)) return
    const rows = await markDeleted(await ctx.database.get("dcqq_relay", {
      forwardChannel: session.channelId,
      forwardId: session.messageId,
      deleted: [0],
    }));
    if (!rows.length) return
    const relation = getRelation(session)
    let c = await ctx.database.getChannel('discord', relation.discordChannel, ['assignee'])
    const dcBot = ctx.bots[`discord:${c.assignee}`]
    for (const data of rows) {
      try {
        await deleteBySelf(dcBot, relation.discordChannel, data.dcId);
      } catch (e) {
        logger.error("delete dc message failed, dc channel id %s, message id %s, forward channel %s, forward message id %s", relation.discordChannel, data.dcId, session.channelId, session.messageId)
        logger.error(e)
      }
    }
  });
  const adaptDiscordMessage = async (session: Session, downloadAsset: boolean, reverseName: boolean = false, prefix: string = '') => {
    const dcBot = session.bot as unknown as DiscordBot
    const msg = await dcBot.internal.getChannelMessage(session.channelId!, session.messageId!);
    let roles: Role[] = [];
    let members: Record<snowflake, GuildMember> = {};

    let result: segment = <message></message>;
    if (session.quote) {
      // 来自其它频道/服务器的转发消息误触发
      if (session.quote.channel?.id === session.channelId) {
        let quote = await ctx.database.get("dcqq_relay", {
          dcId: [session.quote.id!],
        });
        if (quote.length) {
          result.children.push(segment.quote(quote[0].forwardId));
        }
      } else {
        session.elements = [segment.text("🔁")]
      }
    }

    let username = prefix + (msg.author.global_name ? `${session.event.member?.nick ?? msg.author.global_name} (@${msg.author.username})` : `@${msg.author.username}`)

    // @ts-ignore
    let tmp: segment[] = await segment.transformAsync(session.elements, {
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
            (await dcBot.internal.getGuildMember(session.guildId!, attrs.id));
          members[attrs.id] = member;
          return `@${member.nick ?? member.user?.global_name ?? attrs.name ?? "Unknown"}(@${member.user?.username ?? attrs.id})`
        }
        if (attrs.role) {
          if (roles.length === 0) roles = await dcBot.internal.getGuildRoles(session.guildId!);
          return `@[身份组]${roles.find((r) => r.id === attrs.role)?.name || "未知"} `;
        }
      }
    });
    if (downloadAsset) {
      tmp = await segment.transformAsync(tmp, {
        async img(attrs) {
          const data = await ctx.http.file(attrs.src);
          return segment.image(`data:${attrs.type};base64,${Buffer.from(data.data).toString('base64')}`, attrs.type);
        }
      })
    }
    const onlyHaveAttachments = segment.select(tmp, "text").length === 0 && segment.select(tmp, "img").length > 0
    if (!onlyHaveAttachments || !reverseName) {
      result.children.push(segment.text(`${username}: \n`));
    }
    result.children = result.children.concat(tmp);
    if (onlyHaveAttachments && reverseName) {
      result.children.push(segment.text(`${username}: \n`));
    }
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
  ) as RelayRelation;

  validCtx.platform("discord").on("message-updated", async (session) => {
    if (isRecoveryRelation(getRelation(session))) return
    const dcBot = session.bot as unknown as DiscordBot;
    const dcMsg = await dcBot.internal.getChannelMessage(session.channelId!, session.messageId!)
    if (dcMsg.application_id === dcBot.selfId) return // avatar refreshed
    if (dcMsg.author.id === dcBot.selfId) return

    let [data] = await ctx.database.get("dcqq_relay", {
      dcId: [session.messageId!],
      deleted: [0],
    });
    if (!data && !dcMsg.interaction) return;
    const { forwardChannel, forwardPlatform, downloadAsset, reverseName } = getRelation(session)
    let c = await ctx.database.getChannel(forwardPlatform, forwardChannel, ['assignee'])
    const forwardBot = ctx.bots[`${forwardPlatform}:${c.assignee}`]
    if (data) {
      try {
        await deleteBySelf(forwardBot, data.forwardChannel, data.forwardId);
      } catch (e) {
        logger.error("delete forward message failed, dc channel id %s, message id %s, forward channel %s, forward message id %s", session.channelId, session.messageId, data.forwardChannel, data.forwardId)
        logger.error(e)
      }
    } else {
      // interaction waiting
    }

    const msg = await adaptDiscordMessage(session, downloadAsset, reverseName);
    if (dcMsg.interaction) {
      msg.children = [segment.text(`${dcMsg.interaction.user.global_name} 使用了 /${dcMsg.interaction.name}\n`), ...msg.children]
    } else {
      msg.children.push(segment.text("(edited)"));
    }
    const [forwardId] = await forwardBot.sendMessage(forwardChannel, msg);
    if (data) {
      data.forwardId = forwardId;
      await ctx.database.upsert("dcqq_relay", [data]);
    } else {
      await ctx.database.create("dcqq_relay", {
        dcId: session.messageId!,
        forwardChannel,
        forwardId,
        deleted: 0,
      });
    }
    if (dcDeletedList.includes(session.messageId!)) {
      try { await deleteBySelf(forwardBot, forwardChannel, forwardId) } catch (e) {
        logger.error("delete forward message failed, dc channel id %s, message id %s, forward channel %s, forward message id %s", session.channelId, session.messageId, forwardChannel, forwardId)
        logger.error(e)
      }
    }
  });

  validCtx.platform("discord").middleware(async (session) => {
    await enqueue(getRelation(session), async () => {
      // backlog may overlap with the history that has just been recovered
      if (isRecoveryRelation(getRelation(session)) && await isRelayed(session)) return
      await relayFromDiscord(session)
    })
  });

  const relayFromDiscord = async (session: Session, prefix: string = '') => {
    const relation = getRelation(session);
    // const forwardBot = session.app.bots.find((v) => v.platform !== "discord");
    const dcBot = session.bot as unknown as DiscordBot;

    if (!session.elements!.length) {
      // call command?
      let remote = await dcBot.internal.getChannelMessage(session.channelId!, session.messageId!)
      if (remote.interaction) {
        return;
      }
    }

    const msg = await adaptDiscordMessage(session, relation.downloadAsset, relation.reverseName, prefix);
    let sent = await ctx.broadcast([relation.forwardPlatform + ':' + relation.forwardChannel], msg)
    // let sent = await forwardBot.sendMessage(relation.forwardChannel, msg);
    for (const sentId of sent.filter((v) => v)) {
      await ctx.database.create("dcqq_relay", {
        forwardChannel: relation.forwardChannel,
        forwardId: sentId,
        dcId: session.messageId,
      });
    }
  };

  validCtx.intersect(v => v.platform !== "discord").middleware(async (session) => {
    await enqueue(getRelation(session), async () => {
      // backlog may overlap with the history that has just been recovered
      if (isRecoveryRelation(getRelation(session)) && await isRelayed(session)) return
      await relayToDiscord(session)
    })
  });

  const relayToDiscord = async (session: Session, prefix: string = '') => {
    const relation = getRelation(session);
    const forwardBot = session.bot;
    if (session.author.id === session.bot.selfId) return;
    let result: segment = <message />;
    result.children.push(
      <author
        name={`${prefix}${relation.showQQId ? `[QQ:${session.userId}] ` : ''}${session.username}`}
        avatar={session.author.avatar}
      />
    );
    if (session.event.message?.quote) {
      let [quote] = await ctx.database.get("dcqq_relay", {
        forwardId: [session.event.message.quote.id!],
      });
      if (quote) {
        result.children.push(<quote id={quote.dcId} />);
      } else {
        logger.warn("quote not found %o", session.event.message.quote);
      }
    }
    let tmp = await segment.transformAsync(session.elements!, {
      async at(attrs) {
        if (attrs.id === forwardBot.selfId) return "";
        if (attrs.type === "all") return "@全体成员"
        let name = attrs.name ?? "Unknown"
        try {
          let info = await forwardBot.getGuildMember(session.guildId!, attrs.id);
          name ??= attrs.name ?? info.nick ?? info.user?.name
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
      face(attrs) {
        let alt = get(attrs.id);
        return alt ? `[${alt.QDes.slice(1)}]` : `[表情: ${attrs.id}]`;
      },
      text(attrs) {
        attrs.content = attrs.content.replace(/^(\d+)\./, '$1\u200B.')
        let tmp = []
        let splited = attrs.content.matchAll(/(https?:\/\/[^\s<]+[^<.,:;"')\]\s])/g)
        let nowIndex = 0
        for (const item of splited) {
          tmp.push(attrs.content.slice(nowIndex, item.index))
          tmp.push(<a href={item[0]}></a>)
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
  };

  ctx.command("recovery <begin:string> <platform:string>", { authority: 4 })
    .option("dry", "--dry Dry run, do not send messages")
    .action(async ({ session, options }, beginTime, platform) => {
      if (recovering) return "正在恢复中"
      const begin = new Date(beginTime).getTime()
      logger.warn('%o', new Date(beginTime).toLocaleString())
      if (Number.isNaN(begin)) return `无效的时间: ${beginTime}`
      const relations = config.relations.filter((v) => v.forwardPlatform === platform && isRecoveryRelation(v))
      if (!relations.length) return `no relations of platform ${platform}`
      logger.info("recovery from %s, platform %s, %d relations", beginTime, platform, relations.length)

      recovering = true
      let total = 0
      try {
        for (const relation of relations) {
          try {
            total += await recoverRelation(relation, begin, session.messageId, options.dry)
          } catch (e) {
            logger.error("recovery of %s <-> discord:%s failed", relation.forwardPlatform + ':' + relation.forwardChannel, relation.discordChannel)
            logger.error(e)
          }
          if (!options.dry) {
            // release the backlog even if the history sync failed, otherwise the relation stays blocked
            const queue = getQueue(relation)
            queue.ready = true
            logger.info("relation %s done, %d pending messages", relation.forwardChannel, queue.ticket - queue.serving)
          }
        }
        return `恢复完成，共 ${total} 条消息`
      } finally {
        recovering = false
      }
    })

  // sync history of both sides in time order, returns the number of synced messages
  const recoverRelation = async (relation: RelayRelation, begin: number, excludeId: string, dry: boolean) => {
    const dcBot = await getBot('discord', relation.discordChannel)
    const forwardBot = await getBot(relation.forwardPlatform, relation.forwardChannel)
    if (!dcBot || !forwardBot) {
      logger.warn("bot not found for relation %s <-> discord:%s", relation.forwardPlatform + ':' + relation.forwardChannel, relation.discordChannel)
      return 0
    }
    const history = [
      ...(await getHistory(dcBot, relation.discordChannel, begin)).map((m) => ({ bot: dcBot, m })),
      ...(await getHistory(forwardBot, relation.forwardChannel, begin)).map((m) => ({ bot: forwardBot, m })),
    ].sort((a, b) => a.m.createdAt - b.m.createdAt)
    logger.info("relation %s, %d history messages", relation.forwardChannel, history.length)

    let count = 0
    for (const { bot, m } of history) {
      if (m.id === excludeId) continue
      if (m.user?.id === bot.selfId) continue
      m.elements ??= segment.parse(m.content)
      // @ts-ignore
      m.elements = segment.transform(m.elements, {
        quote(attrs) {
          return
        }
      })
      delete m.quote
      const isDiscord = bot.platform === 'discord'
      const channelId = isDiscord ? relation.discordChannel : relation.forwardChannel
      const s = bot.session({
        type: 'message',
        channel: { type: Universal.Channel.Type.TEXT, ...m.channel, id: channelId },
        guild: isDiscord ? { id: relation.discordGuild } : m.guild ?? { id: channelId },
        user: m.user,
        member: m.member,
        message: m,
        timestamp: m.createdAt,
      })
      // messages relayed before the disconnection, or sent by this bot through webhook
      if (await isRelayed(s)) continue
      const prefix = `${RECOVERY_PREFIX} [${toUTC8String(m.createdAt)}] `
      logger.info("recover %s message %s", bot.platform, m.id)
      count++
      if (dry) continue
      try {
        if (isDiscord) await relayFromDiscord(s, prefix)
        else await relayToDiscord(s, prefix)
      } catch (e) {
        logger.error("recover %s message %s failed", bot.platform, m.id)
        logger.error(e)
      }
      await ctx.sleep(1000)
    }
    return count
  }

  ctx
    .command("relay", "查看同步插件帮助信息")
    .action(
      () => `仓库地址: https://github.com/koishijs/koishi-plugin-dcqq-relay`
    );
}
