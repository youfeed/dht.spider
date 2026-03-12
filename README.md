# BT DHT Spider

BitTorrent DHT 爬虫 - 用于爬取种子 InfoHash 和下载种子元数据

## 功能特性

- ✅ 纯 Node.js 实现，无需编译
- ✅ 主动爬取 DHT 网络发现 InfoHash
- ✅ 被动收集其他节点的 announce 信息
- ✅ 通过磁力链接下载种子元数据
- ✅ 支持 IPv4 DHT 协议

## 安装

```bash
npm install
```

## 使用方法

### 1. 网络测试

测试 DHT 网络连通性：

```bash
npm test
```

### 2. 运行爬虫

启动 DHT 爬虫，收集网络中的 InfoHash：

```bash
npm run spider
```

爬虫会：
- 连接到引导节点
- 发现并维护 DHT 路由表
- 被动收集 announce 的 InfoHash
- 每 10 秒输出统计信息
- 退出时保存数据到 `dht_data.json`

### 3. 下载种子元数据

下载指定磁力链接的种子元数据：

修改 `download.js` 中的磁力链接：

```javascript
const config = {
  magnetUrl: 'magnet:?xt=urn:btih:这里替换为40位infohash',
  queryTimeout: 60000,
  downloadTimeout: 120000
};
```

运行：

```bash
npm run download
```

## 测试磁力链接

- Ubuntu ISO: `magnet:?xt=urn:btih:c9e15763f722f23e98a29decdfae341b98d53056`
- Sintel: `magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10`

## 服务器部署

### Linux 服务器

```bash
# 克隆项目
git clone <your-repo>
cd bt-dht-spider

# 安装依赖
npm install

# 后台运行爬虫
nohup npm run spider > spider.log 2>&1 &

# 查看日志
tail -f spider.log
```

### 使用 PM2 管理进程

```bash
# 安装 PM2
npm install -g pm2

# 启动爬虫
pm2 start spider.js --name dht-spider

# 启动下载
pm2 start download.js --name dht-downloader

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
3. **资源占用**：爬虫会占用网络带宽，建议限制并发连接数
4. **合法性**：请遵守当地法律法规，仅用于合法用途

## 项目结构

```
bt-dht-spider/
├── spider.js           # DHT 爬虫核心模块
├── download.js         # 元数据下载脚本
├── test-network.js     # 网络连通性测试
├── package.json        # 项目配置
└── README.md           # 项目说明
```

## 许可证

MIT
