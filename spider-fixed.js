const dgram = require('dgram');
const crypto = require('crypto');
const fs = require('fs');

/**
 * BitTorrent DHT Spider - 修复版
 * 实现完整的 BEP-0005 协议
 */

class DHTSpider {
  constructor(options = {}) {
    this.port = options.port || 6881;
    this.socket = dgram.createSocket('udp4');
    this.nodeId = crypto.randomBytes(20);
    this.maxNodes = options.maxNodes || 2000;

    // 路由表
    this.routingTable = new Map();
    this.nodeQueue = [];

    // 待响应的事务
    this.pendingTransactions = new Map();

    // 引导节点
    this.bootstrapNodes = [
      'router.bittorrent.com:6881',
      'dht.transmissionbt.com:6881',
      'router.utorrent.com:6881',
      'dht.libtorrent.org:6881',
      '104.238.174.223:6881',
      '188.166.112.30:6881'
    ];

    // 收集的数据
    this.collectedInfoHashes = new Set();

    // 统计
    this.stats = {
      messagesSent: 0,
      messagesReceived: 0,
      nodesDiscovered: 0,
      infoHashesFound: 0,
      peersFound: 0,
      pingSuccess: 0,
      pingFailed: 0
    };

    this.onInfoHash = options.onInfoHash || (() => {});
    this.onPeer = options.onPeer || (() => {});
  }

  async start() {
    return new Promise((resolve) => {
      this.socket.bind(this.port, '0.0.0.0', () => {
        console.log(`\n🕷️  DHT Spider 启动`);
        console.log(`📡 监听: ${this.port}`);
        console.log(`🔑 节点 ID: ${this.nodeId.toString('hex')}\n`);
        resolve();
      });

      this.socket.on('message', (msg, rinfo) => {
        this.handleMessage(msg, rinfo);
      });

      this.socket.on('error', (err) => {
        console.error(`❌ Socket 错误:`, err.message);
      });

      // 定期维护
      setInterval(() => this.maintainRouting(), 30000);
      setInterval(() => this.printStats(), 10000);
      setInterval(() => this.crawlNext(), 200);

      // 开始引导
      setTimeout(() => this.bootstrap(), 1000);
    });
  }

  async bootstrap() {
    console.log('🌐 连接引导节点...');

    for (const addr of this.bootstrapNodes) {
      const [ip, port] = addr.split(':');
      console.log(`   📡 ${addr}`);
      await this.sendPing(ip, parseInt(port));
      await this.sleep(200);
    }

    console.log(`✅ 已发送 ${this.bootstrapNodes.length} 个 ping 请求\n`);
  }

  // ==================== 消息发送 ====================

  sendPing(ip, port) {
    return this.sendMessage(ip, port, 'ping', { id: this.nodeId });
  }

  sendFindNode(ip, port, target) {
    return this.sendMessage(ip, port, 'find_node', {
      id: this.nodeId,
      target: target
    });
  }

  sendGetPeers(ip, port, infoHash) {
    return this.sendMessage(ip, port, 'get_peers', {
      id: this.nodeId,
      info_hash: infoHash
    });
  }

  sendMessage(ip, port, query, args) {
    const transactionId = crypto.randomBytes(2);

    // 构建 DHT 消息
    const message = {
      t: transactionId,
      y: 'q',
      q: query,
      a: args
    };

    try {
      const encoded = bencode(message);

      // 记录事务
      const txKey = `${ip}:${port}:${transactionId.toString('hex')}`;
      this.pendingTransactions.set(txKey, {
        type: query,
        args,
        timestamp: Date.now()
      });

      this.socket.send(encoded, port, ip, (err) => {
        if (err) {
          this.stats.pingFailed++;
        } else {
          this.stats.messagesSent++;
        }
      });

      return transactionId;
    } catch (e) {
      console.error(`编码错误 ${query}:`, e.message);
      return null;
    }
  }

  // ==================== 消息处理 ====================

  handleMessage(msg, rinfo) {
    this.stats.messagesReceived++;

    try {
      const decoded = bdecode(msg);

      if (!decoded) {
        return;
      }

      // 处理响应
      if (decoded.y === 'r') {
        this.handleResponse(decoded, rinfo);
      }
      // 处理查询
      else if (decoded.y === 'q') {
        this.handleQuery(decoded, rinfo);
      }

    } catch (e) {
      // 忽略错误
    }
  }

  handleResponse(resp, rinfo) {
    const key = `${rinfo.address}:${rinfo.port}`;

    // 记录节点
    if (resp.r && resp.r.id) {
      const nodeId = Buffer.isBuffer(resp.r.id) ? resp.r.id : Buffer.from(resp.r.id, 'hex');
      this.addNode(nodeId, rinfo.address, rinfo.port);
    }

    // 处理节点列表
    if (resp.r && resp.r.nodes) {
      this.processNodes(resp.r.nodes);
    }

    // 处理 peers
    if (resp.r && resp.r.values) {
      const peers = this.decodePeers(resp.r.values);
      const infoHash = this.routingTable.get(key)?.currentInfoHash;

      if (infoHash && peers.length > 0) {
        this.stats.peersFound += peers.length;
        console.log(`🎯 [${infoHash.substring(0, 16)}...] ${peers.length} peers`);
        peers.forEach(p => this.onPeer({ ...p, infoHash }));
      }
    }
  }

  handleQuery(query, rinfo) {
    const key = `${rinfo.address}:${rinfo.port}`;

    // 记录节点
    if (query.a && query.a.id) {
      const nodeId = Buffer.isBuffer(query.a.id) ? query.a.id : Buffer.from(query.a.id, 'hex');
      this.addNode(nodeId, rinfo.address, rinfo.port);
    }

    // 响应 ping
    if (query.q === 'ping' && query.t) {
      this.sendResponse(rinfo.address, rinfo.port, query.t, { id: this.nodeId });
    }

    // 响应 find_node
    if (query.q === 'find_node' && query.a && query.a.target) {
      const target = Buffer.isBuffer(query.a.target) ? query.a.target : Buffer.from(query.a.target, 'hex');
      const nodes = this.getClosestNodes(target, 8);
      this.sendResponse(rinfo.address, rinfo.port, query.t, { id: this.nodeId, nodes });
    }

    // 响应 get_peers
    if (query.q === 'get_peers' && query.a && query.a.info_hash) {
      const infoHash = Buffer.isBuffer(query.a.info_hash)
        ? query.a.info_hash.toString('hex')
        : query.a.info_hash;

      if (!this.collectedInfoHashes.has(infoHash)) {
        this.collectedInfoHashes.add(infoHash);
        this.stats.infoHashesFound++;
        console.log(`📦 [${infoHash.substring(0, 16)}...] announce`);
        this.onInfoHash(infoHash);
      }

      const infoHashBuffer = Buffer.isBuffer(query.a.info_hash)
        ? query.a.info_hash
        : Buffer.from(query.a.info_hash, 'hex');
      const nodes = this.getClosestNodes(infoHashBuffer, 8);
      const token = crypto.randomBytes(4);

      this.sendResponse(rinfo.address, rinfo.port, query.t, {
        id: this.nodeId,
        token,
        nodes
      });
    }
  }

  sendResponse(ip, port, transactionId, data) {
    const resp = {
      t: transactionId,
      y: 'r',
      r: data
    };

    try {
      this.socket.send(bencode(resp), port, ip);
    } catch (e) {
      // 忽略错误
    }
  }

  // ==================== 节点管理 ====================

  addNode(nodeId, ip, port) {
    const key = `${ip}:${port}`;

    if (this.routingTable.has(key)) {
      this.routingTable.get(key).lastSeen = Date.now();
      return false;
    }

    if (this.routingTable.size < this.maxNodes) {
      this.routingTable.set(key, {
        id: nodeId,
        ip,
        port,
        lastSeen: Date.now(),
        currentInfoHash: null
      });

      this.stats.nodesDiscovered++;

      if (this.nodeQueue.length < 500) {
        this.nodeQueue.push(key);
      }

      return true;
    }

    return false;
  }

  processNodes(nodes) {
    if (!nodes || nodes.length < 26) return;

    const count = Math.floor(nodes.length / 26);

    for (let i = 0; i < nodes.length; i += 26) {
      if (i + 26 > nodes.length) break;

      const id = nodes.slice(i, i + 20);
      const ip = `${nodes[i + 20]}.${nodes[i + 21]}.${nodes[i + 22]}.${nodes[i + 23]}`;
      const port = nodes.readUInt16BE(i + 24);

      this.addNode(id, ip, port);
    }

    if (count > 0) {
      this.stats.pingSuccess++;
    }
  }

  decodePeers(values) {
    const peers = [];
    for (let i = 0; i < values.length; i += 6) {
      if (i + 6 > values.length) break;

      const ip = `${values[i]}.${values[i + 1]}.${values[i + 2]}.${values[i + 3]}`;
      const port = values.readUInt16BE(i + 4);
      peers.push({ ip, port });
    }
    return peers;
  }

  getClosestNodes(target, count = 8) {
    const targetBuffer = Buffer.isBuffer(target) ? target : Buffer.from(target, 'hex');

    const nodes = Array.from(this.routingTable.values())
      .map(n => ({
        ...n,
        distance: this.xorDistance(n.id, targetBuffer)
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, count);

    const result = Buffer.alloc(nodes.length * 26);
    nodes.forEach((node, i) => {
      const offset = i * 26;
      node.id.copy(result, offset);
      const ipParts = node.ip.split('.').map(Number);
      result[offset + 20] = ipParts[0];
      result[offset + 21] = ipParts[1];
      result[offset + 22] = ipParts[2];
      result[offset + 23] = ipParts[3];
      result.writeUInt16BE(node.port, offset + 24);
    });

    return result;
  }

  xorDistance(id1, id2) {
    let dist = 0n;
    for (let i = 0; i < 20; i++) {
      const b1 = BigInt(Buffer.isBuffer(id1) ? id1[i] : id1);
      const b2 = BigInt(Buffer.isBuffer(id2) ? id2[i] : id2);
      dist = (dist << 8n) | (b1 ^ b2);
    }
    return dist;
  }

  // ==================== 爬取逻辑 ====================

  crawlNext() {
    if (this.nodeQueue.length === 0) return;

    const key = this.nodeQueue.shift();
    const node = this.routingTable.get(key);
    if (!node) return;

    // 随机查询 infohash
    const randomInfoHash = crypto.randomBytes(20);
    node.currentInfoHash = randomInfoHash.toString('hex');

    this.sendGetPeers(node.ip, node.port, randomInfoHash);
  }

  maintainRouting() {
    const now = Date.now();
    const expired = [];

    this.routingTable.forEach((node, key) => {
      if (now - node.lastSeen > 900000) { // 15分钟过期
        expired.push(key);
      }
    });

    expired.forEach(key => this.routingTable.delete(key));
  }

  printStats() {
    console.log(`\n📊 ${new Date().toLocaleTimeString()}`);
    console.log(`   发送: ${this.stats.messagesSent} | 接收: ${this.stats.messagesReceived}`);
    console.log(`   节点: ${this.routingTable.size} | 新增: ${this.stats.nodesDiscovered}`);
    console.log(`   InfoHash: ${this.stats.infoHashesFound} | Peers: ${this.stats.peersFound}`);

    // 重置周期统计
    this.stats.nodesDiscovered = 0;
    this.stats.infoHashesFound = 0;
    this.stats.peersFound = 0;
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ==================== bencode ====================

function bencode(obj) {
  if (typeof obj === 'string') {
    return `${obj.length}:${obj}`;
  } else if (typeof obj === 'number') {
    return `i${obj}e`;
  } else if (Buffer.isBuffer(obj)) {
    return `${obj.length}:${obj}`;
  } else if (Array.isArray(obj)) {
    return `l${obj.map(bencode).join('')}e`;
  } else if (typeof obj === 'object' && obj !== null) {
    const keys = Object.keys(obj).sort();
    return `d${keys.map(k => bencode(k) + bencode(obj[k])).join('')}e`;
  }
  return '';
}

function bdecode(buffer) {
  try {
    const [result, offset] = bdecodeRecursive(buffer, 0);
    return result;
  } catch (e) {
    return null;
  }
}

function bdecodeRecursive(buffer, offset) {
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
    let i = offset + 1;
    while (i < buffer.length && String.fromCharCode(buffer[i]) !== 'e') {
      i++;
    }
    if (i >= buffer.length) return [null, offset];
    return [parseInt(buffer.slice(offset + 1, i).toString()), i + 1];
  } else if (/\d/.test(char)) {
    const colon = buffer.indexOf(':', offset);
    if (colon === -1) return [null, offset];
    const len = parseInt(buffer.slice(offset, colon).toString());
    if (colon + 1 + len > buffer.length) return [null, offset];
    return [buffer.slice(colon + 1, colon + 1 + len), colon + 1 + len];
  }

  return [null, offset];
}

// ==================== 启动 ====================

if (require.main === module) {
  const spider = new DHTSpider({
    port: 6881,
    maxNodes: 3000
  });

  spider.start().then(() => {
    console.log('✅ DHT Spider 运行中...\n');
  });

  process.on('SIGINT', () => {
    console.log('\n\n🛑 正在停止...');
    process.exit(0);
  });
}

module.exports = DHTSpider;
