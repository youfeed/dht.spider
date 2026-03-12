const DHTSpiderClass = require('./spider-fixed.js');
const DHTSpider = DHTSpiderClass.DHTSpider || DHTSpiderClass;

// 配置
const config = {
  magnetUrl: 'magnet:?xt=urn:btih:c9e15763f722f23e98a29decdfae341b98d53056', // Ubuntu ISO
  queryTimeout: 60000,
  downloadTimeout: 120000
};

// 解析磁力链接
function parseMagnet(magnet) {
  const match = magnet.match(/magnet:\?xt=urn:btih:([a-fA-F0-9]{40})/);
  if (!match) {
    throw new Error('无效的磁力链接');
  }
  return match[1];
}

async function main() {
  try {
    const infoHash = parseMagnet(config.magnetUrl);
    console.log(`🎯 目标 InfoHash: ${infoHash}\n`);

    // 创建爬虫
    const spider = new DHTSpiderClass({
      port: 6881,
      maxNodes: 3000,
      onInfoHash: (hash) => {
        // 收集到新 InfoHash
      }
    });

    await spider.start();

    console.log('🕷️  开始查询 InfoHash...');

    // 等待路由表建立
    await new Promise(r => setTimeout(r, 30000));

    // 查询指定 InfoHash
    let peerCount = 0;
    const checkPeers = setInterval(() => {
      const count = spider.collectedInfoHashes.size + peerCount;
      if (count > 0) {
        console.log(`📥 已收集到数据，开始下载元数据...`);
        clearInterval(checkPeers);
        process.exit(0);
      }
    }, 5000);

    // 超时检查
    setTimeout(() => {
      console.log('⏰ 查询超时');
      process.exit(1);
    }, config.queryTimeout);

  } catch (error) {
    console.error('错误:', error.message);
    process.exit(1);
  }
}

main();
