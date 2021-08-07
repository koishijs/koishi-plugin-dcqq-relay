# koishi-plugin-dcqq-relay

[![npm](https://img.shields.io/npm/v/koishi-plugin-dcqq-relay?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-ink)

插件用于QQ和Discord间的消息互通，开发原意为拯救[屎山](https://github.com/Teahouse-Studios/Discord-QQ-Msg-Relay)

## 安装
```
yarn add koishi-plugin-dcqq-relay
```

## 升级注意
由 `0.1.x` 升级到 `0.2.0` 有数据库表结构修改, 插件不提供旧数据的迁移

## 配置
请首先根据 [使用数据库](https://koishi.js.org/guide/database.html) 对 koishi 进行配置

配置样例如下 (非完整 koishi 用法)

``` typescript
import { apply } from 'koishi-plugin-dcqq-relay'
import * as mysql from 'koishi-plugin-mysql'

// process.env.XXX 的值请根据实际情况修改

app.plugin(mysql.apply, {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
})

app.plugin(apply, {
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