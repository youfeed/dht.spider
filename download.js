const DHTSpider = require('./spider.js').DHTSpider;
const MetadataDownloader = require('./spider.js').MetadataDownloader;

// 配置
const config = {
    magnetUrl: 'magnet:?xt=urn:btih:c9e15763f722f23e98a29decdfae341b98d53056', // Ubuntu ISO
    // 或者使用 Sintel 测试视频：
    // magnetUrl: 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10',
    queryTimeout: 60000,  // 查询 Peers 超时（毫秒）- 增加到 60 秒
    downloadTimeout: 120000 // 下载元数据超时（毫秒）- 增加到 120 秒
};

// 解析磁力链接
try {
    const infoHash = MetadataDownloader.parseMagnet(config.magnetUrl);
    console.log(`🎯 目标 InfoHash: ${infoHash}`);

    // 创建元数据下载器
    const downloader = new MetadataDownloader(infoHash);
    global.metadataDownloader = downloader;

    // 创建爬虫
    const spider = new DHTSpider({
        port: 6881,
        maxNodes: 5000,
        onPeer: (peer) => {
            if (!downloader.completed) {
                downloader.addPeer(peer.ip, peer.port);
            }
        }
    });

    spider.start();

    console.log('🕷️  爬虫启动中...');

    // 查询指定 InfoHash
    setTimeout(() => {
        console.log(`🔍 开始查询 InfoHash...`);
        spider.queryInfoHash(infoHash);
    }, 5000);

    // 开始下载元数据
    setTimeout(() => {
        if (downloader.peers.size === 0) {
            console.log('❌ 未找到任何 Peers');
            console.log(`📊 当前状态: 路由表节点数=${spider.routingTable.size}`);
            console.log('💡 提示:');
            console.log('   1. 检查网络连接');
            console.log('   2. 尝试延长查询时间');
            console.log('   3. 使用其他磁力链接');
            console.log('   4. 检查防火墙设置');
            process.exit(1);
        }

        console.log(`📥 找到 ${downloader.peers.size} 个 Peers，开始下载元数据...`);
        downloader.start().then(success => {
            process.exit(success ? 0 : 1);
        });
    }, 5000 + config.queryTimeout);

    // 超时处理
    setTimeout(() => {
        if (!downloader.completed) {
            console.log('⏰ 下载超时');
            console.log(`📊 当前进度: ${downloader.pieces.size}/${downloader.piecesCount}`);
            process.exit(1);
        }
    }, 5000 + config.queryTimeout + config.downloadTimeout);

    process.on('SIGINT', () => {
        console.log('\n正在退出...');
        process.exit(0);
    });

} catch (error) {
    console.error('错误:', error.message);
    console.log('\n使用方法:');
    console.log('1. 修改 config.magnetUrl 为真实的磁力链接');
    console.log('2. 运行: node download.js');
    process.exit(1);
}
