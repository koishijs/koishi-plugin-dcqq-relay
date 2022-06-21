import { Context, Session, Logger, segment } from 'koishi'
import { OneBotBot } from '@koishijs/plugin-adapter-onebot'
import { DiscordBot, Sender } from '@koishijs/plugin-adapter-discord'
import { Embed, GuildMember, Message, Role, snowflake } from "@koishijs/plugin-adapter-discord/lib/types";
import type { } from '@koishijs/plugin-adapter-onebot'
// @ts-ignore
import { data } from 'qface'
interface RelayRelation {
  discordChannel: string;
  discordGuild: string;
  onebotChannel: string;
  webhookId: string;
  webhookToken: string;
  discordLogChannel?: string;
}

export interface Config {
  onebotSelfId: string;
  discordToken: string;
  relations: RelayRelation[]
}

let c: Config;
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



export async function apply(ctx: Context, config?: Config) {
  c = config
  ctx.model.extend(TableName, {
    id: 'unsigned',
    dcId: 'string',
    onebotId: 'string',
    deleted: 'integer',
    message: 'text'
  }, {
    autoInc: true
  })
  ctx.on('message-updated', async (meta) => {
    if (config.relations.map(v => v.webhookId).includes(meta.userId)) {
      return;
    }
    if (!config.relations.map(v => v.discordChannel).concat(config.relations.map(v => v.onebotChannel)).includes(meta.channelId)) {
      return
    }
    if (meta.platform === "discord") {
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
        // @ts-ignore
        const msg = await adaptMessage(meta as unknown as Session.Payload<"message", any>)
        data[0].onebotId = (await onebot.sendMessage(onebotChannel, msg + "(edited)"))[0]
        data[0].deleted = 0
        await ctx.database.upsert(TableName, data)
      } else {
      }
    }
  })

  ctx.platform('discord').on('message-deleted', async (meta) => {
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
  ctx.platform('onebot').on('message-deleted', async (meta) => {
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

  ctx.on('message', async (meta) => {
    if (!config.relations.map(v => v.discordChannel).concat(config.relations.map(v => v.onebotChannel)).includes(meta.channelId)) {
      return
    }
    if (config.relations.map(v => v.webhookId).includes(meta.userId)) {
      return;
    }
    if (meta.content.startsWith("//")) {
      return;
    }
    const relation = config.relations.find(v => v.onebotChannel === meta.channelId || v.discordChannel === meta.channelId)
    if (meta.platform === 'discord') {
      await meta.preprocess()
      const onebot = meta.app.bots.find(v => v.platform === 'onebot') as unknown as OneBotBot
      const msg = await adaptMessage(meta)
      let sendId = (await onebot.sendMessage(relation.onebotChannel, msg))[0]
      await ctx.database.create(TableName, {
        onebotId: sendId,
        message: meta.content,
        dcId: meta.messageId
      })
    } else {
      const dcBot = meta.app.bots.find(v => v.platform === 'discord') as unknown as DiscordBot
      const data = await adaptOnebotMessage(meta)
      let send = Sender.from(dcBot, `/webhooks/${relation.webhookId}/${relation.webhookToken}?wait=true`)
      let sentId = (await send(data.content, { ...data, tts: false }))[0]
      await ctx.database.create(TableName, {
        onebotId: meta.messageId,
        message: meta.content,
        dcId: sentId
      })
    }
  })

  ctx.command('relay', '查看同步插件帮助信息')
    .action(() => `仓库地址: https://github.com/koishijs/koishi-plugin-dcqq-relay`)

  ctx.platform('discord')
    .channel(...config.relations.map(v => v.discordChannel))
    .command('send-separately <message:text>')
    .action(async ({ session: meta }, message: string) => {
      const relation = config.relations.find(v => v.discordChannel === meta.channelId)
      await meta.preprocess()
      const onebot = meta.app.bots.find(v => v.platform === 'onebot') as unknown as OneBotBot
      const msg = await adaptMessage(meta, message)
      await onebot.sendMessage(relation.onebotChannel,
        meta.author.nickname !== meta.author.username
          ? `${meta.author.nickname}(${meta.author.username}#${meta.author.discriminator})`
          : `${meta.author.username}#${meta.author.discriminator}`
      )
      let sendId = (await onebot.sendMessage(relation.onebotChannel, msg))[0]
      await ctx.database.create(TableName, {
        onebotId: sendId,
        message: meta.content,
        dcId: meta.messageId
      })
    })

  // @ts-ignore
  const adaptMessage = async (meta: Session.Payload<"message", any>, message?: string) => {
    const dcBot = meta.app.bots.find(v => v.platform === 'discord') as unknown as DiscordBot
    const msg = message ?? await dcBot.internal.getChannelMessage(meta.channelId, meta.messageId)
    let roles: Role[] = undefined
    let members: Record<snowflake, GuildMember> = {}
    let contents = (await Promise.all(segment.parse(meta.content).map(async v => {
      if (v.type === "face") {
        return segment('image', { file: `https://cdn.discordapp.com/emojis/${v.data.id}` })
      } else if (v.type === "file") {
        return `[文件: ${v.data.file}]`
      } else if (v.type === "video") {
        return `[视频: ${v.data.file}]`
      } else if (v.type === "sharp") {
        // @ts-ignore
        let channel = await dcBot.$getChannel(v.data.id)
        return `[频道: ${channel.name}(${v.data.id})]`
      } else if (v.type === 'at') {
        if (v.data.type === "here") {
          return `@${v.data.type}`
        } else if (v.data.type === 'all') {
          return segment.join([v]).trim()
        }

        const dcBot = meta.bot as DiscordBot
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

    let quotePrefix = ""
    if (meta.quote) {
      let quote = await ctx.database.get(TableName, {
        dcId: [meta.quote.messageId]
      })
      if (quote.length) {
        quotePrefix = segment('reply', { id: quote[0].onebotId })
      }
    }
    let username
    if (meta.author.nickname !== meta.author.username) {
      username = `${meta.author.nickname}(${meta.author.username}#${meta.author.discriminator})`
    } else {
      username = `${meta.author.username}#${meta.author.discriminator}`
    }
    if(message !== undefined) return contents
    return `${quotePrefix}${username}:\n${contents}`
  }
  // @ts-ignore
  const adaptOnebotMessage = async (meta: Session.Payload<"message", any>) => {
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
        return segment.unescape(v.data.content).trim()
      }
      if (v.type === 'image' && v.data.type === 'flash') {
        return ''
      }
      if (v.type === 'reply') {
        return ''
      }
      if (v.type === 'face') {
        let alt = data.find(face => face.QSid === v.data.id)
        return alt ? `[${alt.QDes.slice(1)}]` : `[表情: ${v.data.id}]`
      }
      return segment.join([v]).trim()
    }))).join('')
    contents = contents.replace(/@everyone/g, () => '\\@everyone').replace(/@here/g, () => '\\@here')
    const relation = c.relations.find(v => v.onebotChannel === meta.channelId || v.discordChannel === meta.channelId)
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
}