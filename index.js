import { downloadMagnet } from './spider.js'

// 配置
const config = {
  magnetUrl: 'magnet:?xt=urn:btih:e3811b9539cacff680e418124272177c47477157',
  timeout: 180000 // 3 分钟超时
}

// 开始下载
downloadMagnet(config.magnetUrl, config.timeout)
