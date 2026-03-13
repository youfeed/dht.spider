# BT DHT Spider

BitTorrent DHT 爬虫 - 用于爬取种子 InfoHash 和查询 Peers

## 功能特性

- ✅ 使用成熟的 `bittorrent-dht` 库
- ✅ 主动爬取 DHT 网络发现 InfoHash
- ✅ 被动收集其他节点的 announce 信息
- ✅ 查询指定磁力链接的 Peers
- ✅ 纯 Node.js 实现，无需编译

## 安装

```bash
npm install
```

## 使用方法

### 1. 运行爬虫（收集 InfoHash）

启动 DHT 爬虫，主动发现网络中的 InfoHash：

```bash
node dht-bt.mjs
```

爬虫会：
- 连接到引导节点
- 主动爬取随机 InfoHash
- 被动收集 announce 的 InfoHash
- 每 10 秒输出统计信息
- 退出时保存数据到 `dht_data.json`

### 2. 查询指定磁力链接的 Peers

修改 `query-magnet.mjs` 中的磁力链接：

```javascript
const config = {
  magnetUrl: 'magnet:?xt=urn:btih:这里替换为40位infohash'
};
```

运行：

```bash
node query-magnet.mjs
```

## 测试磁力链接

- Ubuntu ISO: `magnet:?xt=urn:btih:c9e15763f722f23e98a29decdfae341b98d53056`
- Sintel: `magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10`

## 输出示例

```
🚀 启动 DHT Spider...

🕷️  DHT 就绪
🔑 节点 ID: ac09d6d87ba4576caa598c325bf1320a1138b987

📡 已添加引导节点

📊 07:44:33
   InfoHash: 3
   Peers: 2

📦 新 InfoHash: 5956906c8a2cee2f...
📦 新 InfoHash: 15d4204db7383f79...
📦 新 InfoHash: a118a8aceceb0640...

📊 07:44:43
   InfoHash: 6
   Peers: 2
```

## 服务器部署

### Linux 服务器

```bash
# 上传项目到服务器
scp -r . user@server:/path/to/

# SSH 连接
ssh user@server

# 安装依赖
cd /path/to/bt-dht-spider
npm install

# 后台运行爬虫
nohup node dht-bt.mjs > spider.log 2>&1 &

# 查看日志
tail -f spider.log
```

### 使用 PM2 管理进程

```bash
# 安装 PM2
npm install -g pm2

# 启动爬虫
pm2 start dht-bt.mjs --name dht-spider

# 查看日志
pm2 logs dht-spider

# 停止进程
pm2 stop dht-spider

# 开机自启
pm2 startup
pm2 save
```

## 注意事项

1. **防火墙设置**：确保 UDP 6881 端口未被防火墙阻止
2. **网络环境**：某些 ISP 可能限制 P2P 流量
3. **警告信息**：`Unexpected transaction id` 警告可以忽略，不影响功能
4. **合法性**：请遵守当地法律法规，仅用于合法用途

## 项目结构

```
bt-dht-spider/
├── dht-bt.mjs         # DHT 爬虫核心（使用 bittorrent-dht）
├── query-magnet.mjs    # 磁力链接查询脚本
├── package.json        # 项目配置
└── README.md           # 项目说明
```

## 许可证

MIT

