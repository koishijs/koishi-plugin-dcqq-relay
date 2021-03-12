# koishi-plugin-dcqq-relay

[![npm](https://img.shields.io/npm/v/koishi-plugin-dcqq-relay?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-ink)

插件用于QQ和Discord间的消息互通，开发原意为拯救[屎山](https://github.com/Teahouse-Studios/Discord-QQ-Msg-Relay)

## 安装
```
yarn add koishi-plugin-dcqq-relay
```

## 配置
你需要一个mysql数据库

配置样例如下

``` typescript
import { apply } from 'koishi-plugin-dcqq-relay'

app.plugin(apply, {
  database: {
    host: process.env.DB_HOST,
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
  },
  relations: [{
    discordChannel: process.env.CHANNEL_DISCORD,
    onebotChannel: process.env.CHANNEL_ONEBOT,
    discordGuild: process.env.GUILD_DISCORD,
    webhookId: process.env.WEBHOOK_ID,
    webhookToken: process.env.WEBHOOK_TOKEN,
  }],
  onebotSelfId: process.env.ONEBOT_SELFID,
  discordToken: process.env.DISCORD_TOKEN
})
```