import { Context, Session, Logger, segment, Schema } from 'koishi'
import { OneBotBot } from '@koishijs/plugin-adapter-onebot'
import { DiscordBot, Sender } from '@koishijs/plugin-adapter-discord'
import { Embed, GuildMember, Role, snowflake } from "@satorijs/adapter-discord/lib/types";
import type { } from '@koishijs/plugin-adapter-onebot'
import { get } from 'qface'
interface RelayRelation {
  discordChannel: string;
  discordGuild: string;
  onebotChannel: string;
  webhookId: string;
  webhookToken: string;
  discordLogChannel?: string;
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

const TableName = "dcqq_relay"

export const Config: Schema<Config> = Schema.object({
  relations: Schema.array(Schema.object({
    discordChannel: Schema.string().required(),
    discordGuild: Schema.string().required(),
    onebotChannel: Schema.string().required(),
    webhookId: Schema.string().required(),
    webhookToken: Schema.string().required(),
    discordLogChannel: Schema.string(),
  }))
})
export const using = ['database'] as const

export async function apply(ctx: Context, config: Config) {
  ctx.model.extend(TableName, {
    id: 'unsigned',
    dcId: 'string',
    onebotId: 'string',
    deleted: 'integer',
    message: 'text'
  }, {
    autoInc: true
  })

  const validCtx = ctx.intersect(session => [...config.relations.map(v => v.discordChannel), ...config.relations.map(v => v.onebotChannel)].includes(session.channelId))
    .exclude(session => config.relations.map(v => v.webhookId).includes(session.userId))
    .exclude(session => session.content?.startsWith("//"))

  validCtx.platform('discord').on('message-deleted', async (meta) => {
    let data = await ctx.database.get(TableName, { dcId: [meta.messageId], deleted: [0] })
    if (data.length) {
      data[0].deleted = 1
      await ctx.database.upsert(TableName, data)
      const onebot = meta.app.bots.find(v => v.platform === 'onebot') as unknown as OneBotBot
      try {
        await onebot.deleteMessage('', data[0].onebotId)
      } catch (e) {

      }
    }
  })
  validCtx.platform('onebot').on('message-deleted', async (meta) => {
    let data = await ctx.database.get(TableName, { onebotId: [meta.messageId.toString()], deleted: [0] })
    if (data.length) {
      data[0].deleted = 1
      await ctx.database.upsert(TableName, data)
      const discordChannel = config.relations.find(v => v.onebotChannel === meta.channelId)
      const dcBot = meta.app.bots.find(v => v.platform === 'discord') as unknown as DiscordBot
      try {
        await dcBot.deleteMessage(discordChannel.discordChannel, data[0].dcId)
      } catch (e) {

      }
      if (discordChannel.discordLogChannel) {
        await dcBot.sendMessage(discordChannel.discordLogChannel, `[QQ:${meta.userId}]撤回消息:\n${data[0].message}`)
      }
    }
  })

  const adaptDiscordMessage = async (meta: Session) => {
    const dcBot = meta.app.bots.find(v => v.platform === 'discord') as unknown as DiscordBot
    const msg = await dcBot.internal.getChannelMessage(meta.channelId, meta.messageId)
    let roles: Role[] = undefined
    let members: Record<snowflake, GuildMember> = {}


    let quotePrefix = ""
    let contents = (await Promise.all(segment.parse(meta.content).map(async v => {
      if (v.type === "face") {
        return segment('image', { url: `https://cdn.discordapp.com/emojis/${v.data.id}` })
      } else if (v.type === "file") {
        return `[文件: ${v.data.file}]`
      } else if (v.type === "video") {
        return `[视频: ${v.data.file}]`
      } else if (v.type === "sharp") {
        let channel = await dcBot.internal.getChannel(v.data.id)
        return `[频道: ${channel.name}(${v.data.id})]`
      } else if (v.type === 'at') {
        if (v.data.type === "here") {
          return `@${v.data.type}`
        } else if (v.data.type === 'all') {
          return segment.join([v]).trim()
        }

        const dcBot = meta.bot
        if (v.data.id) {
          let member = members[v.data.id] || await dcBot.internal.getGuildMember(meta.guildId, v.data.id)
          members[v.data.id] = member
          let username

          if (member.nick && member.nick !== member.user.username) {
            username = `${member.nick}(${member.user.username}#${member.user.discriminator})`
          } else {
            username = `${member.user.username}#${member.user.discriminator}`
          }
          return `@${username} `
        }
        if (v.data.role) {
          roles = roles || await dcBot.internal.getGuildRoles(meta.guildId)
          return `@[身分組]${roles.find(r => r.id === v.data.role)?.name || '未知'} `
        }
        return ''
      } else if (v.type === "share") {
        return v.data?.title + ' ' + v.data.url
      } else if (v.type === 'quote') {
        let quote = await ctx.database.get(TableName, {
          dcId: [v.data.id]
        })
        if (quote.length) {
          quotePrefix = segment('reply', { id: quote[0].onebotId })
        }
        return ''
      }
      return segment.join([v]).trim()
    }))).join('')
    contents = msg.embeds.map(embed => {
      let rtn = ''
      rtn += embed.description || ''
      embed.fields?.forEach(field => {
        rtn += `${field.name}: ${field.value}\n`
      })
      return rtn
    }) + contents
    if (msg.sticker_items) {
      contents += msg.sticker_items.map(v => segment('image', { url: `https://cdn.discordapp.com/stickers/${v.id}.png` })).join('')
    }
    let username
    if (meta.author.nickname !== meta.author.username) {
      username = `${meta.author.nickname}(${meta.author.username}#${meta.author.discriminator})`
    } else {
      username = `${meta.author.username}#${meta.author.discriminator}`
    }
    return `${quotePrefix}${username}:\n${contents}`
  }

  validCtx.platform('discord').on('message-updated', async (meta) => {
    await meta.preprocess()
    const onebot = meta.app.bots.find(v => v.platform === 'onebot') as unknown as OneBotBot
    let data = await ctx.database.get(TableName, { dcId: [meta.messageId], deleted: [0] })
    const onebotChannel = config.relations.find(v => v.discordChannel === meta.channelId).onebotChannel
    if (data.length) {
      data[0].deleted = 1
      await ctx.database.upsert(TableName, data)
      try {
        await onebot.deleteMessage('', data[0].onebotId)
      } catch (e) {
      }
      const msg = await adaptDiscordMessage(meta)
      data[0].onebotId = (await onebot.sendMessage(onebotChannel, msg + "(edited)"))[0]
      data[0].deleted = 0
      await ctx.database.upsert(TableName, data)
    }
  })

  validCtx.platform('discord').on('message', async (meta) => {
    const relation = config.relations.find(v => v.discordChannel === meta.channelId)
    await meta.preprocess()
    const onebot = meta.app.bots.find(v => v.platform === 'onebot') as unknown as OneBotBot
    const msg = await adaptDiscordMessage(meta)
    let sent = await onebot.sendMessage(relation.onebotChannel, msg)
    for (const sentId of sent.filter(v => v)) {
      await ctx.database.create(TableName, {
        onebotId: sentId,
        message: meta.content,
        dcId: meta.messageId
      })
    }
  })

  validCtx.platform('onebot').on('message', async (meta) => {
    const relation = config.relations.find(v => v.onebotChannel === meta.channelId)
    const dcBot = meta.app.bots.find(v => v.platform === 'discord') as unknown as DiscordBot

    const adaptOnebotMessage = async () => {
      const onebot = meta.app.bots.find(v => v.platform === 'onebot') as unknown as OneBotBot
      let parsed = segment.parse(meta.content)
      const quoteObj = parsed.find(v => v.type === 'quote')
      let quoteId = null
      let _quote: any;
      if (quoteObj) {
        let quote = await ctx.database.get(TableName, {
          onebotId: [quoteObj.data.id]
        })
        if (quote.length) {
          quoteId = quote[0].dcId
          _quote = quote[0]
        } else {
          logger.info('quote not found %s', quoteObj.data.id)
        }
      }
      let embeds: Embed[] = []
      let contents = (await Promise.all(parsed.map(async v => {
        if (v.type === "quote") {
          return ''
        }
        if (v.type === 'at') {
          if (v.data.id === onebot.selfId) {
            return ''
          }
          let info = await onebot.getGuildMember(meta.guildId, v.data.id)
          return `@[QQ: ${v.data.id}]${info.nickname} `
        }
        if (v.type === 'text') {
          return segment.unescape(v.data.content.replace(/\*|_|~|`|^\>/, (v) => `\\${v}`)).trim()
        }
        if (v.type === 'image' && v.data.type === 'flash') {
          return ''
        }
        if (v.type === 'reply') {
          return ''
        }
        if (v.type === "image" || v.type === "video") {
          delete v.data.file
        }
        if (v.type === 'face') {
          let alt = get(v.data.id)
          return alt ? `[${alt.QDes.slice(1)}]` : `[表情: ${v.data.id}]`
        }
        return segment.join([v]).trim()
      }))).join('')
      contents = contents.replace(/@everyone/g, () => '\\@everyone').replace(/@here/g, () => '\\@here')
      const relation = config.relations.find(v => v.onebotChannel === meta.channelId || v.discordChannel === meta.channelId)
      if (quoteId) {
        embeds.push({
          description: `回复 | [[ ↑ ]](https://discord.com/channels/${relation.discordGuild}/${relation.discordChannel}/${quoteId})`,
          footer: {
            text: segment.parse(_quote?.message || '').filter(v => v.type === "text").map(v => segment.join([v])).join('')
          }
        })
      }
      return {
        content: contents,
        embeds,
        username: `[QQ:${meta.userId}] ${meta.username}`,
        avatar_url: `https://q1.qlogo.cn/g?b=qq&nk=${meta.userId}&s=640`
      }
    }

    const data = await adaptOnebotMessage()
    let send = Sender.from(dcBot, `/webhooks/${relation.webhookId}/${relation.webhookToken}?wait=true`)
    let sent = await send(data.content, { ...data, tts: false })
    for (const sentId of sent) {
      await ctx.database.create(TableName, {
        onebotId: meta.messageId,
        message: meta.content,
        dcId: sentId
      })
    }
  })

  ctx.command('relay', '查看同步插件帮助信息')
    .action(() => `仓库地址: https://github.com/koishijs/koishi-plugin-dcqq-relay`)

}