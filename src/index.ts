import { App, Context, Session } from 'koishi-core'
import 'reflect-metadata'
import { CQBot } from 'koishi-adapter-onebot/dist/bot'
import { DiscordBot } from 'koishi-adapter-discord/dist/bot'
import { Logger, segment } from 'koishi-utils'
import { createConnection, getConnection } from 'typeorm'
import { MessageRelation } from './entity/message'
import { Embed } from 'koishi-adapter-discord/dist/types'
require('dotenv').config()

export interface Config {
  host: string;
  username: string;
  password: string;
  database: string;
  onebotSelfId: string;
  discordChannel: string;
  onebotChannel: string;
  discordGuild: string;
  webhookId: string;
  webhookToken: string;
  discordToken: string;
}

let c: Config;

export async function apply (ctx: Context, config?: Config) {
  const { host, username, password, database } = config
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
    if (meta.userId === config.webhookId) {
      return;
    }
    
    if (meta.platform === "discord") {
      const onebot = meta.app._bots.find(v => v.platform === 'onebot') as unknown as CQBot
      let data = await getConnection().getRepository(MessageRelation).findOne({
        discord: meta.messageId,
        deleted: false
      })
      if (data) {
        data.deleted = true
        await getConnection().getRepository(MessageRelation).save(data)
        try{
          await onebot.deleteMessage('', data.onebot)
        }catch(e){}
        const msg = await adaptMessage(meta as unknown as Session.Payload<"message", any>)
        let sendId = await onebot.sendGroupMessage(c.onebotChannel, msg + "(edited)")
        data.onebot = sendId
        data.deleted = false
        await getConnection().getRepository(MessageRelation).save(data)
      } else { }
    }
  })

  ctx.on('message-deleted', async (meta) => {
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
      if (data) {
        await dcBot.deleteMessage(config.discordChannel, data.discord)
        data.deleted = true
        await getConnection().getRepository(MessageRelation).save(data)
      }
    }
  })

  ctx.on('message', async (meta) => {
    if (meta.channelId !== config.discordChannel && meta.channelId !== config.onebotChannel) {
      return
    }
    if (meta.userId === config.webhookId) {
      return;
    }
    if (meta.platform === 'discord') {
      const onebot = meta.app._bots.find(v => v.platform === 'onebot') as unknown as CQBot
      const msg = await adaptMessage(meta)
      let sendId = await onebot.sendGroupMessage(config.onebotChannel, msg)
      let r = new MessageRelation()
      r.discord = meta.messageId
      r.onebot = sendId
      r.message = segment.parse(meta.content).filter(v => v.type === "text").map(v => segment.join([v])).join('')
      await getConnection().getRepository(MessageRelation).save(r)
    } else {
      const dcBot = meta.app._bots.find(v => v.platform === 'discord') as unknown as DiscordBot
      const data = await adaptOnebotMessage(meta)
      let sentId = await dcBot.executeWebhook(config.webhookId, config.webhookToken, data, true)
      let r = new MessageRelation()
      r.discord = sentId
      r.onebot = meta.messageId
      r.message = segment.parse(meta.content).filter(v => v.type === "text").map(v => segment.join([v])).join('')
      await getConnection().getRepository(MessageRelation).save(r)
    }
  })
}

const adaptMessage = async (meta: Session.Payload<"message", any>) => {
  let contents = segment.parse(meta.content).map(v => {
    if (v.type === "face") {
      return `:${v.data.name}:`
    } else if (v.type === "file") {
      return `[文件: ${v.data.file}]`
    } else if (v.type === "video") {
      return `[视频: ${v.data.file}]`
    } else if(v.type === 'at'){
      if(v.data.type === "here"){
        return `@${v.data.type}`
      }else if(v.data.type === 'all'){
        return segment.join([v]).trim()
      }
      return `@${v.data.role || v.data.id}`
    }else if(v.type === "share"){
      return v.data?.title + ' ' + v.data.url
    }
    return segment.join([v]).trim()
  }).join('')
  let quotePrefix = ""
  let quoteObj: MessageRelation | null;
  if (meta.quote) {
    quoteObj = await getConnection().getRepository(MessageRelation).findOne({
      discord: meta.quote.messageId
    })
    quotePrefix = segment('reply', { id: quoteObj.onebot })
  }
  let username = ""
  if(meta.author.nickname !== meta.author.username){
    username = `${meta.author.nickname}(${meta.author.username}#${meta.author.discriminator})`
  }else {
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
    return segment.join([v]).trim()
  }).join('')
  contents = contents.replace(/@everyone/, () => '@ everyone').replace(/@here/, () => '@ here')

  if (quoteId) {
    embeds.push({
      description: `回复 | [[ ↑ ]](https://discord.com/channels/${c.discordGuild}/${c.discordChannel}/${quoteId})`,
      footer: {
        text: quote.message
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
