import { App } from 'koishi'
import 'koishi-adapter-discord'
import 'koishi-adapter-onebot'
import { CQBot } from 'koishi-adapter-onebot/dist/bot'
import { DiscordBot } from 'koishi-adapter-discord/dist/bot'
import axios from 'axios'
import { Logger, segment } from 'koishi-utils'
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

let logger = new Logger('discord')
logger.level = 3

app.on('message', (meta) => {
  if (meta.channelId !== process.env.CHANNEL_DISCORD && meta.channelId !== process.env.CHANNEL_ONEBOT) {
    return
  }
  if (meta.userId === process.env.WEBHOOK_ID) {
    return;
  }
  if (meta.platform === 'discord') {
    const onebot = meta.app._bots.find(v => v.platform === 'onebot') as unknown as CQBot
    let contents = segment.parse(meta.content).map(v => {
      if (v.type === "face") {
        return `:${v.data.name}:`
      } else if (v.type === "file") {
        return `[文件: ${v.data.file}]`
      } else if (v.type === "video") {
        return `[视频: ${v.data.file}]`
      }
      console.log(v)
      return segment.join([v])
    }).join('')
    onebot.sendGroupMessage(process.env.CHANNEL_ONEBOT, `${meta.author.username}#${meta.author.discriminator}:\n${contents}`)
  } else {
    const dcBot = meta.app._bots.find(v => v.platform === 'discord') as unknown as DiscordBot
    let contents = meta.content
    console.log(contents)
    dcBot.executeWebhook(process.env.WEBHOOK_ID, process.env.WEBHOOK_TOKEN, {
      content: contents,
      username: `[QQ:${meta.userId}]${meta.username}`,
      avatar_url: `https://q1.qlogo.cn/g?b=qq&nk=${meta.userId}&s=640`
    })
  }
})

app.start()
