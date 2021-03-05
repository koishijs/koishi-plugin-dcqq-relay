import { App, Session } from 'koishi'
import 'reflect-metadata'
import 'koishi-adapter-discord'
import 'koishi-adapter-onebot'
import { CQBot } from 'koishi-adapter-onebot/dist/bot'
import { DiscordBot } from 'koishi-adapter-discord/dist/bot'
import axios from 'axios'
import { Logger, segment } from 'koishi-utils'
import { createConnection, getConnection } from 'typeorm'
import { MessageRelation } from './entity/message'
import { Embed } from 'koishi-adapter-discord/dist/types'
require('dotenv').config()

axios.interceptors.request.use(req => {
  console.log(req.data)
  return req
})

const app = new App({
  bots: [{
    type: 'discord',
    token: process.env.DISCORD_TOKEN,
  }, {
    type: 'onebot',
    selfId: process.env.ONEBOT_SELFID,
    server: 'ws://127.0.0.1:6700',
  }],
})
/*
app.plugin(require('koishi-plugin-mysql'), {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE
})
*/


let logger = new Logger('discord')
//logger.level = 3

const adaptMessage = async (meta: Session.Payload<"message", any>) => {
  let contents = segment.parse(meta.content).map(v => {
    if (v.type === "face") {
      return `:${v.data.name}:`
    } else if (v.type === "file") {
      return `[文件: ${v.data.file}]`
    } else if (v.type === "video") {
      return `[视频: ${v.data.file}]`
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
  return `${quotePrefix}${meta.author.username}#${meta.author.discriminator}:\n${contents}`
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

  if (quoteId) {
    embeds.push({
      description: `回复 | [[ ↑ ]](https://discord.com/channels/${process.env.GUILD_DISCORD}/${process.env.CHANNEL_DISCORD}/${quoteId})`,
      footer: {
        text: quote.message
      }
    })
  }
  return {
    content: contents,
    embeds,
    username: `[QQ:${meta.userId}]${meta.username}`,
    avatar_url: `https://q1.qlogo.cn/g?b=qq&nk=${meta.userId}&s=640`
  }
}

app.on('message-updated', async (meta) => {
  if (meta.platform === "discord") {
    const onebot = meta.app._bots.find(v => v.platform === 'onebot') as unknown as CQBot
    let data = await getConnection().getRepository(MessageRelation).findOne({
      discord: meta.messageId,
      deleted: false
    })
    if (data) {
      data.deleted = true
      await getConnection().getRepository(MessageRelation).save(data)
      await onebot.deleteMessage('', data.onebot)
      const msg = await adaptMessage(meta as unknown as Session.Payload<"message", any>)
      let sendId = await onebot.sendGroupMessage(process.env.CHANNEL_ONEBOT, msg + "(edited)")
      data.onebot = sendId
      data.deleted = false
      await getConnection().getRepository(MessageRelation).save(data)
    }else{}
  }
})

app.on('message-deleted', async (meta) => {
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
      await dcBot.deleteMessage(process.env.CHANNEL_DISCORD, data.discord)
      data.deleted = true
      await getConnection().getRepository(MessageRelation).save(data)
    }
  }
})

app.on('message', async (meta) => {
  if (meta.channelId !== process.env.CHANNEL_DISCORD && meta.channelId !== process.env.CHANNEL_ONEBOT) {
    return
  }
  if (meta.userId === process.env.WEBHOOK_ID) {
    return;
  }
  if (meta.platform === 'discord') {
    const onebot = meta.app._bots.find(v => v.platform === 'onebot') as unknown as CQBot
    const msg = await adaptMessage(meta)
    let sendId = await onebot.sendGroupMessage(process.env.CHANNEL_ONEBOT, msg)
    let r = new MessageRelation()
    r.discord = meta.messageId
    r.onebot = sendId
    r.message = segment.parse(meta.content).filter(v => v.type === "text").map(v => segment.join([v])).join('')
    await getConnection().getRepository(MessageRelation).save(r)
  } else {
    const dcBot = meta.app._bots.find(v => v.platform === 'discord') as unknown as DiscordBot
    const data = await adaptOnebotMessage(meta)
    let sentId = await dcBot.executeWebhook(process.env.WEBHOOK_ID, process.env.WEBHOOK_TOKEN, data, true)
    let r = new MessageRelation()
    r.discord = sentId
    r.onebot = meta.messageId
    r.message = segment.parse(meta.content).filter(v => v.type === "text").map(v => segment.join([v])).join('')
    await getConnection().getRepository(MessageRelation).save(r)
  }
})

createConnection({
  type: "mysql",
  host: process.env.DB_HOST,
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  synchronize: process.env.NODE_ENV !== 'development',
  entities: [MessageRelation]
}).then(() => {
  app.start()
})