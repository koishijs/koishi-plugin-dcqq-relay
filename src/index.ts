import 'koishi-adapter-discord'
import 'koishi-adapter-onebot'
import { App, Context, Session } from 'koishi-core'
import 'reflect-metadata'
import { CQBot } from 'koishi-adapter-onebot/dist/bot'
import { DiscordBot } from 'koishi-adapter-discord/dist/bot'
import { Logger, segment } from 'koishi-utils'
import { createConnection, getConnection } from 'typeorm'
import { MessageRelation } from './entity/message'
import { Embed } from 'koishi-adapter-discord/dist/types'
require('dotenv').config()

interface RelayRelation {
  discordChannel: string;
  discordGuild: string;
  onebotChannel: string;
  webhookId: string;
  webhookToken: string;
  discordLogChannel?: string;
}

export interface Config {
  database: {
    host: string;
    username: string;
    password: string;
    database: string;
  }
  onebotSelfId: string;
  discordToken: string;
  relations: RelayRelation[]
}

let c: Config;

export async function apply(ctx: Context, config?: Config) {
  const { host, username, password, database } = config.database
  c = config
  await createConnection({
    type: "mysql",
    host,
    username,
    password,
    database,
    synchronize: process.env.NODE_ENV !== 'development',
    entities: [MessageRelation]
  })

  ctx.on('message-updated', async (meta) => {
    if (config.relations.map(v => v.webhookId).includes(meta.userId)) {
      return;
    }

    if (meta.platform === "discord") {
      const onebot = meta.app._bots.find(v => v.platform === 'onebot') as unknown as CQBot
      let data = await getConnection().getRepository(MessageRelation).findOne({
        discord: meta.messageId,
        deleted: false
      })
      const onebotChannel = config.relations.find(v => v.discordChannel === meta.channelId).onebotChannel
      if (data) {
        data.deleted = true
        await getConnection().getRepository(MessageRelation).save(data)
        try {
          await onebot.deleteMessage('', data.onebot)
        } catch (e) { }
        const msg = await adaptMessage(meta as unknown as Session.Payload<"message", any>)
        let sendId = await onebot.sendGroupMessage(onebotChannel, msg + "(edited)")
        data.onebot = sendId
        data.deleted = false
        await getConnection().getRepository(MessageRelation).save(data)
      } else { }
    }
  })

  ctx.on('message-deleted', async (meta) => {
    if (!config.relations.map(v => v.discordChannel).concat(config.relations.map(v => v.onebotChannel)).includes(meta.channelId)) {
      return
    }
    if (config.relations.map(v => v.webhookId).includes(meta.userId)) {
      return;
    }
    console.log('deleted', meta.messageId, meta.platform)
    if (meta.platform === "discord") {
      const onebot = meta.app._bots.find(v => v.platform === 'onebot') as unknown as CQBot
      let data = await getConnection().getRepository(MessageRelation).findOne({
        discord: meta.messageId,
        deleted: false
      })
      if (data) {
        await onebot.deleteMessage('', data.onebot)
        data.deleted = true
        await getConnection().getRepository(MessageRelation).save(data)
      }
    } else {
      const dcBot = meta.app._bots.find(v => v.platform === 'discord') as unknown as DiscordBot
      let data = await getConnection().getRepository(MessageRelation).findOne({
        onebot: meta.messageId.toString(),
        deleted: false
      })
      const discordChannel = config.relations.find(v => v.onebotChannel === meta.channelId)
      if (data) {
        await dcBot.deleteMessage(discordChannel.discordChannel, data.discord)
        data.deleted = true
        await getConnection().getRepository(MessageRelation).save(data)
        if(discordChannel.discordLogChannel){
          await dcBot.sendMessage(discordChannel.discordLogChannel, `[QQ:${meta.userId}]撤回消息:\n${data.message}`)
        }
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
    const relation = config.relations.find(v => v.onebotChannel === meta.channelId || v.discordChannel === meta.channelId)
    if (meta.platform === 'discord') {
      const onebot = meta.app._bots.find(v => v.platform === 'onebot') as unknown as CQBot
      const msg = await adaptMessage(meta)

      let sendId = await onebot.sendGroupMessage(relation.onebotChannel, msg)
      let r = new MessageRelation()
      r.discord = meta.messageId
      r.onebot = sendId
      r.message = meta.content
      await getConnection().getRepository(MessageRelation).save(r)
    } else {
      const dcBot = meta.app._bots.find(v => v.platform === 'discord') as unknown as DiscordBot
      const data = await adaptOnebotMessage(meta)
      let sentId = await dcBot.executeWebhook(relation.webhookId, relation.webhookToken, data, true)
      let r = new MessageRelation()
      r.discord = sentId
      r.onebot = meta.messageId
      r.message = meta.content
      await getConnection().getRepository(MessageRelation).save(r)
    }
  })
}

const adaptMessage = async (meta: Session.Payload<"message", any>) => {
  let contents = segment.parse(meta.content).map(v => {
    if (v.type === "face") {
      return segment('image', { file: `https://cdn.discordapp.com/emojis/${v.data.id}` })
    } else if (v.type === "file") {
      return `[文件: ${v.data.file}]`
    } else if (v.type === "video") {
      return `[视频: ${v.data.file}]`
    } else if (v.type === 'at') {
      if (v.data.type === "here") {
        return `@${v.data.type}`
      } else if (v.data.type === 'all') {
        return segment.join([v]).trim()
      }
      return `@${v.data.role || v.data.id}`
    } else if (v.type === "share") {
      return v.data?.title + ' ' + v.data.url
    }
    return segment.join([v]).trim()
  }).join('')
  contents = meta.discord?.embeds?.map(embed => {
    let rtn = ''
    rtn += embed.description || ''
    embed.fields?.forEach(field => {
      rtn += `${field.name}: ${field.value}\n`
    })
    return rtn
  }) + contents
  
  let quotePrefix = ""
  let quoteObj: MessageRelation | null;
  if (meta.quote) {
    quoteObj = await getConnection().getRepository(MessageRelation).findOne({
      discord: meta.quote.messageId
    })
    quotePrefix = segment('reply', { id: quoteObj.onebot })
  }
  let username = ""
  if (meta.author.nickname !== meta.author.username) {
    username = `${meta.author.nickname}(${meta.author.username}#${meta.author.discriminator})`
  } else {
    username = `${meta.author.username}#${meta.author.discriminator}`
  }
  return `${quotePrefix}${username}:\n${contents}`
}
const adaptOnebotMessage = async (meta: Session.Payload<"message", any>) => {
  let parsed = segment.parse(meta.content)
  const quoteObj = parsed.find(v => v.type === 'quote')
  let quoteId = null
  let quote: MessageRelation | null = null;
  if (quoteObj) {
    quote = await getConnection().getRepository(MessageRelation).findOne({
      onebot: quoteObj.data.id
    })
    if (quote) {
      quoteId = quote.discord
    } else {
      console.log('quote not found')
    }
  }
  let embeds: Embed[] = []
  let contents = parsed.map(v => {
    if (v.type === "quote") {
      return ''
    }
    if (v.type === 'at') {
      return ''
    }
    if (v.type === 'text') {
      return segment.unescape(v.data.content)
    }
    if(v.type === 'image' && v.data.type === 'flash'){
      return ''
    }
    return segment.join([v]).trim()
  }).join('')
  contents = contents.replace(/@everyone/, () => '@ everyone').replace(/@here/, () => '@ here')
  const relation = c.relations.find(v => v.onebotChannel === meta.channelId || v.discordChannel === meta.channelId)
  if (quoteId) {
    embeds.push({
      description: `回复 | [[ ↑ ]](https://discord.com/channels/${relation.discordGuild}/${relation.discordChannel}/${quoteId})`,
      footer: {
        text: segment.parse(quote.message).filter(v => v.type === "text").map(v => segment.join([v])).join('')
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
