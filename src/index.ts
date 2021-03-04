import {App} from 'koishi'
require('dotenv').config()
import 'koishi-adapter-discord'
import 'koishi-adapter-onebot'

const app = new App({
  bots: [{
    type: "discord",
    token: "ODE2OTc5OTMzNTYxNjE4NDUy.YEC12g.HCyRQ7-Iit1c_VuSd5Gq2CoUb8w"
  }, {
    type: "onebot",
    selfId: process.env.ONEBOT_SELFID,
    server: "ws://127.0.0.1:6700"
  }]
})

app.on('message', (meta) => {
  console.log(meta.platform, meta.content)
})

app.start()
