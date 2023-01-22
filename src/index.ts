import { Context, Session, Logger, segment, Schema, Element, Dict } from 'koishi'
import { OneBotBot } from '@koishijs/plugin-adapter-onebot'
import { Discord, DiscordBot } from '@koishijs/plugin-adapter-discord'
import { Embed, GuildMember, Role, snowflake } from "@satorijs/adapter-discord/lib/types";
import FormData from 'form-data'
import type { } from '@koishijs/plugin-adapter-onebot'
import { get } from 'qface'

import { fromBuffer } from 'file-type'
interface RelayRelation {
  discordChannel?: string;
  discordGuild?: string;
  onebotChannel: string;
  webhookId?: string;
  webhookToken?: string;
  webhookUrl: string;
  // discordLogChannel?: string;
}

export interface Config {
  relations: RelayRelation[]
}

const logger = new Logger('relay')

export interface RelayTable {
  id: number
  dcId: string;
  onebotId: string;
  deleted: number;
  message: string;
}

declare module 'koishi' {
  interface Tables {
    dcqq_relay: RelayTable
  }
}

export const Config: Schema<Config> = Schema.object({
  relations: Schema.array(
    Schema.object({
      webhookUrl: Schema.string(),
      onebotChannel: Schema.string().required(),
      discordChannel: Schema.string(),
      discordGuild: Schema.string(),
      webhookId: Schema.string(),
      webhookToken: Schema.string(),
    })
  )
})

export const using = ['database'] as const

export async function apply(ctx: Context, config: Config) {
  ctx.model.extend("dcqq_relay", {
    id: 'unsigned',
    dcId: 'string',
    onebotId: 'string',
    deleted: 'integer',
    message: 'text'
  }, {
    autoInc: true
  })

  for await (const webhook of config.relations) {
    if (webhook.webhookUrl) {
      let data = await ctx.http.get<Discord.Webhook>(webhook.webhookUrl)
      webhook.webhookId = data.id
      webhook.webhookToken = data.token
      webhook.discordChannel = data.channel_id
      webhook.discordGuild = data.guild_id
    }
  }

  const validCtx = ctx.intersect(session => [...config.relations.map(v => v.discordChannel), ...config.relations.map(v => v.onebotChannel)].includes(session.channelId))
    .exclude(session => config.relations.map(v => v.webhookId).includes(session.userId))
  // .exclude(session => session.content?.startsWith("//"))

  validCtx.platform('discord').on('message-deleted', async (session) => {
    let data = await ctx.database.get("dcqq_relay", { dcId: [session.messageId], deleted: [0] })
    if (data.length) {
      data[0].deleted = 1
      await ctx.database.upsert("dcqq_relay", data)
      const onebot = session.app.bots.find(v => v.platform === 'onebot') as unknown as OneBotBot
      try {
        await onebot.deleteMessage('', data[0].onebotId)
      } catch (e) {

      }
    }
  })
  validCtx.platform('onebot').on('message-deleted', async (session) => {
    let data = await ctx.database.get("dcqq_relay", { onebotId: [session.messageId.toString()], deleted: [0] })
    if (data.length) {
      data[0].deleted = 1
      await ctx.database.upsert("dcqq_relay", data)
      const discordChannel = config.relations.find(v => v.onebotChannel === session.channelId)
      const dcBot = session.app.bots.find(v => v.platform === 'discord') as unknown as DiscordBot
      try {
        await dcBot.deleteMessage(discordChannel.discordChannel, data[0].dcId)
      } catch (e) {

      }
      // if (discordChannel.discordLogChannel) {
      //   await dcBot.sendMessage(discordChannel.discordLogChannel, `[QQ:${session.userId}]撤回消息:\n${data[0].message}`)
      // }
    }
  })

  const adaptDiscordMessage = async (session: Session) => {
    const dcBot = ctx.bots.find(v => v.platform === 'discord') as unknown as DiscordBot
    const msg = await dcBot.internal.getChannelMessage(session.channelId, session.messageId)
    let roles: Role[] = undefined
    let members: Record<snowflake, GuildMember> = {}

    let result: segment.Fragment = []
    if (session.quote) {
      let quote = await ctx.database.get("dcqq_relay", {
        dcId: [session.quote.messageId]
      })
      if (quote.length) {
        result.push(Element.quote(quote[0].onebotId))
      }
    }

    let username
    if (session.author.nickname !== session.author.username) {
      username = `${session.author.nickname}(${session.author.username}#${session.author.discriminator})`
    } else {
      username = `${session.author.username}#${session.author.discriminator}`
    }

    result.push(`${username}: \n`)
    for (const element of segment.parse(session.content)) {
      const { type, attrs, children } = element
      if (type === "face") {
        result.push(segment.image(`https://cdn.discordapp.com/emojis/${attrs.id}`))
      } else if (type === "file") {
        result.push(`[文件: ${attrs.file}](${attrs.url})`)
      } else if (type === "video") {
        result.push(`[视频: ${attrs.file}](${attrs.url})`)
      } else if (type === "sharp") {
        let channel = await dcBot.internal.getChannel(attrs.id)
        result.push(`[频道: ${channel.name}(${attrs.id})]`)
      } else if (type === "at") {
        if (attrs.type === "here") {
          result.push(`@${attrs.type}`)
        } else if (attrs.type === 'all') {
          result.push('@everyone')
        }

        const dcBot = session.bot
        if (attrs.id) {
          let member = members[attrs.id] || await dcBot.internal.getGuildMember(session.guildId, attrs.id)
          members[attrs.id] = member
          let username

          if (member.nick && member.nick !== member.user.username) {
            username = `${member.nick}(${member.user.username}#${member.user.discriminator})`
          } else {
            username = `${member.user.username}#${member.user.discriminator}`
          }
          result.push(`@${username} `)
        }
        if (attrs.role) {
          roles = roles || await dcBot.internal.getGuildRoles(session.guildId)
          result.push(`@[身分組]${roles.find(r => r.id === attrs.role)?.name || '未知'} `)
        }
      } else {
        result.push(element)
      }
    }

    result = [...result, msg.embeds.map(embed => {
      let rtn = ''
      rtn += embed.title ? `${embed.title}\n` : ''
      rtn += embed.description ? `${embed.description}\n` : ''
      embed.fields?.forEach(field => {
        rtn += `${field.name}: ${field.value}\n`
      })
      return rtn
    }).join('\n')]
    if (msg.sticker_items) {
      result = [...result, ...msg.sticker_items.map(v => segment('image', { url: `https://cdn.discordapp.com/stickers/${v.id}.png` }))]
    }
    return result
  }

  validCtx.platform('discord').on('message-updated', async (session) => {
    // await meta.preprocess()
    const onebot = ctx.bots.find(v => v.platform === 'onebot') as unknown as OneBotBot
    let data = await ctx.database.get("dcqq_relay", { dcId: [session.messageId], deleted: [0] })
    const onebotChannel = config.relations.find(v => v.discordChannel === session.channelId).onebotChannel
    if (data.length) {
      data[0].deleted = 1
      await ctx.database.upsert("dcqq_relay", data)
      try {
        await onebot.deleteMessage('', data[0].onebotId)
      } catch (e) {
      }
      const msg = await adaptDiscordMessage(session)
      data[0].onebotId = (await onebot.sendMessage(onebotChannel, [...msg, '(edited)']))[0]
      data[0].deleted = 0
      await ctx.database.upsert("dcqq_relay", data)
    }
  })

  validCtx.platform('discord').on('message', async (session) => {
    const relation = config.relations.find(v => v.discordChannel === session.channelId)
    const onebot = session.app.bots.find(v => v.platform === 'onebot') as unknown as OneBotBot
    const msg = await adaptDiscordMessage(session)
    let sent = await onebot.sendMessage(relation.onebotChannel, msg)
    for (const sentId of sent.filter(v => v)) {
      await ctx.database.create("dcqq_relay", {
        onebotId: sentId,
        message: session.content,
        dcId: session.messageId
      })
    }
  })

  validCtx.platform('onebot').on('message', async (session) => {
    const relation = config.relations.find(v => v.onebotChannel === session.channelId)
    const dcBot = ctx.bots.find(v => v.platform === 'discord') as unknown as DiscordBot

    const url = dcBot.config.endpoint + `/webhooks/${relation.webhookId}/${relation.webhookToken}?wait=true`
    let sent = []

    const onebot = ctx.bots.find(v => v.platform === 'onebot') as unknown as OneBotBot
    let parsed = segment.parse(session.content)
    let quoteId = null
    let _quote: RelayTable;
    if (session.quote) {
      let quote = await ctx.database.get("dcqq_relay", {
        onebotId: [session.quote.messageId]
      })
      if (quote.length) {
        quoteId = quote[0].dcId
        _quote = quote[0]
      } else {
        logger.info('quote not found %o', session.quote)
      }
    }
    let embeds: Embed[] = []

    if (quoteId) {
      let quotedUsername;
      let quotedAvatar;

      const quotedMsg = await onebot.getMessage(session.channelId, _quote.onebotId)
      if (quotedMsg.author.userId === onebot.selfId) {
        // sent from relay bot
        const sourceMsg = await dcBot.getMessage(relation.discordChannel, _quote.dcId)
        quotedUsername = sourceMsg.author.nickname || sourceMsg.author.username
        quotedAvatar = sourceMsg.author.avatar
      } else {
        quotedUsername = session.quote.author.nickname || session.quote.author.username
        quotedAvatar = session.quote.author.avatar
      }
      quotedUsername = quotedUsername.replace(/[\\*_`~|()]/g, '\\$&')
      embeds.push({
        description: `${quotedUsername} <t:${Math.ceil(session.quote.timestamp / 1000)}:R> | [[ ↑ ]](https://discord.com/channels/${relation.discordGuild}/${relation.discordChannel}/${quoteId})`,
        footer: {
          text: segment.select(segment.parse(_quote.message), 'text').toString().slice(0, 30),
          icon_url: quotedAvatar
        }
      })
    }
    let buffer = ""

    const addition = {
      username: `[QQ:${session.userId}] ${session.username}`,
      avatar_url: session.author.avatar,
      embeds
    }

    async function sendEmbed(fileBuffer: ArrayBuffer, payload_json: Dict, filename: string) {
      const fd = new FormData()
      if (filename.endsWith(".image") || filename.endsWith(".video")) filename = "";
      filename ||= 'file.' + (await fromBuffer(fileBuffer)).ext
      fd.append('file', Buffer.from(fileBuffer), filename)
      fd.append('payload_json', JSON.stringify(payload_json))
      let r = await ctx.http.post(url, fd, fd.getHeaders())
      sent.push(r.id)
    }

    async function sendAsset(type: string, data: Dict<string>, addition: Dict) {
      const buffer = await ctx.http.get<ArrayBuffer>(data.url, {
        headers: { accept: type + '/*' },
        responseType: 'arraybuffer',
      })
      return sendEmbed(buffer, addition, data.file)
    }

    for (const element of parsed) {
      const { type, attrs, children } = element
      if (type === 'text') {
        buffer += attrs.content.replace(/[\\*_`~|()]/g, '\\$&').replace(/@everyone/g, () => '\\@everyone').replace(/@here/g, () => '\\@here')
      }
      else if (type === 'at') {
        if (attrs.id === onebot.selfId) {
          continue;
        }

        let info = await onebot.getGuildMember(session.guildId, attrs.id)
        buffer += `@[QQ: ${attrs.id}]${info.nickname ?? info.username} `
      } else if (type === "image" && attrs.type === "flash") {
        // do nothing
      } else if (type === "image" || type === "video") {
        await sendAsset(type, attrs, {
          ...addition,
          content: buffer.trim(),
        })
        buffer = ""
      } else if (type === "face") {
        let alt = get(attrs.id)
        buffer += alt ? `[${alt.QDes.slice(1)}]` : `[表情: ${attrs.id}]`
      }
    }
    if (buffer) {
      sent.push((await ctx.http.post(url, { ...addition, content: buffer })).id)
    }
    for (const sentId of sent) {
      await ctx.database.create("dcqq_relay", {
        onebotId: session.messageId,
        message: session.content,
        dcId: sentId
      })
    }
  })

  ctx.command('relay', '查看同步插件帮助信息')
    .action(() => `仓库地址: https://github.com/koishijs/koishi-plugin-dcqq-relay`)
}