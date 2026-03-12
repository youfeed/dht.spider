const dgram = require('dgram');
const crypto = require('crypto');

console.log('🔍 DHT 网络连接测试\n');

const socket = dgram.createSocket('udp4');
const nodeId = crypto.randomBytes(20);

// 引导节点列表
const bootstrapNodes = [
  { ip: '87.98.162.88', port: 6881 },
  { ip: '82.221.103.244', port: 6881 },
  { ip: '185.157.221.247', port: 6881 },
  { ip: '67.215.246.10', port: 6881 },
  { ip: '120.78.162.251', port: 6881 },
  { ip: '182.92.170.134', port: 6881 }
];

// 简化版 bencode
function bencode(obj) {
  if (typeof obj === 'string') {
    return `${obj.length}:${obj}`;
  } else if (Buffer.isBuffer(obj)) {
    return `${obj.length}:${obj.toString()}`;
  } else if (typeof obj === 'number') {
    return `i${obj}e`;
  } else if (Array.isArray(obj)) {
    return `l${obj.map(bencode).join('')}e`;
  } else if (typeof obj === 'object' && obj !== null) {
    const keys = Object.keys(obj).sort();
    return `d${keys.map(k => bencode(k) + bencode(obj[k])).join('')}e`;
  }
  return '';
}

// 简化版 bdecode
function bdecode(buffer) {
  return bdecodeRecursive(buffer)[0];
}

function bdecodeRecursive(buffer, offset = 0) {
  if (offset >= buffer.length) return [null, offset];

  const char = String.fromCharCode(buffer[offset]);

  if (char === 'd') {
    offset++;
    const dict = {};
    while (offset < buffer.length && String.fromCharCode(buffer[offset]) !== 'e') {
      const [key, newOffset] = bdecodeRecursive(buffer, offset);
      const [value, newerOffset] = bdecodeRecursive(buffer, newOffset);
      if (key !== null) dict[key] = value;
      offset = newerOffset;
    }
    return [dict, offset + 1];
  } else if (char === 'l') {
    offset++;
    const list = [];
    while (offset < buffer.length && String.fromCharCode(buffer[offset]) !== 'e') {
      const [item, newOffset] = bdecodeRecursive(buffer, offset);
      if (item !== null) list.push(item);
      offset = newOffset;
    }
    return [list, offset + 1];
  } else if (char === 'i') {
    const end = buffer.indexOf(Buffer.from('e'), offset);
    if (end === -1) return [null, offset];
    return [parseInt(buffer.slice(offset + 1, end).toString()), end + 1];
  } else if (/\d/.test(char)) {
    const colon = buffer.indexOf(Buffer.from(':'), offset);
    if (colon === -1) return [null, offset];
    const len = parseInt(buffer.slice(offset, colon).toString());
    return [buffer.slice(colon + 1, colon + 1 + len), colon + 1 + len];
  }

  return [null, offset];
}

let successCount = 0;
let timeoutCount = 0;

socket.bind(6882, () => {
  console.log(`✅ Socket 绑定成功，端口: 6882`);
  console.log(`🔑 本地节点 ID: ${nodeId.toString('hex')}\n`);

  let testIndex = 0;
  const testNext = () => {
    if (testIndex >= bootstrapNodes.length) {
      console.log('\n📊 测试总结:');
      console.log(`   成功: ${successCount}/${bootstrapNodes.length}`);
      console.log(`   超时: ${timeoutCount}/${bootstrapNodes.length}`);

      if (successCount > 0) {
        console.log('\n✅ 网络连接正常！可以正常使用 DHT');
      } else {
        console.log('\n❌ 网络连接异常！');
        console.log('💡 可能的原因:');
        console.log('   1. 防火墙拦截了 UDP 6881-6889 端口');
        console.log('   2. 路由器/NAT 限制 UDP 通信');
        console.log('   3. ISP 限制 P2P 流量');
        console.log('\n🔧 解决方案:');
        console.log('   1. 在 Windows 防火墙中允许 Node.js 通过');
        console.log('   2. 更换网络环境（如使用手机热点）测试');
        console.log('   3. 尝试使用其他端口');
      }

      setTimeout(() => {
        socket.close();
        process.exit(0);
      }, 2000);
      return;
    }

    const node = bootstrapNodes[testIndex];
    testIndex++;

    console.log(`📡 测试 ${testIndex}/${bootstrapNodes.length}: ${node.ip}:${node.port}`);

    const transaction = crypto.randomBytes(2);
    const query = {
      t: transaction,
      y: 'q',
      q: 'ping',
      a: { id: nodeId }
    };

    const encoded = bencode(query);
    let responded = false;

    const timer = setTimeout(() => {
      if (!responded) {
        console.log(`   ⏰ 超时\n`);
        timeoutCount++;
        testNext();
      }
    }, 5000);

    socket.on('message', function handler(msg, rinfo) {
      if (!responded && rinfo.address === node.ip && rinfo.port === node.port) {
        responded = true;
        clearTimeout(timer);

        try {
          const decoded = bdecode(msg);
          if (decoded && decoded.y === 'r') {
            console.log(`   ✅ 响应成功`);
            if (decoded.r && decoded.r.id) {
              const peerId = Buffer.isBuffer(decoded.r.id)
                ? decoded.r.id.toString('hex')
                : decoded.r.id;
              console.log(`   🆔 Peer ID: ${peerId}`);
            }
            successCount++;
          } else {
            console.log(`   ⚠️  响应格式异常`);
          }
        } catch (e) {
          console.log(`   ❌ 解析失败: ${e.message}`);
        }

        console.log();
        testNext();
      }
    });

    socket.send(encoded, node.port, node.ip, (err) => {
      if (err) {
        clearTimeout(timer);
        console.log(`   ❌ 发送失败: ${err.message}\n`);
        timeoutCount++;
        testNext();
      }
    });
  };

  testNext();
});

socket.on('error', (err) => {
  console.error(`\n❌ Socket 错误: ${err.message}`);
  console.log('\n💡 这通常是端口被占用或防火墙拦截导致的');
  process.exit(1);
});
