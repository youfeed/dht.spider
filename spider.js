const dgram = require('dgram');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');

/**
 * BitTorrent DHT Spider
 * 主动发现网络中的 InfoHash 和 Peer 信息
 */
class DHTSpider {
    constructor(options = {}) {
        this.port = options.port || 6881;
        this.socket = dgram.createSocket('udp4');
        this.nodeId = crypto.randomBytes(20);
        this.maxNodes = options.maxNodes || 1000;
        this.maxQueueSize = options.maxQueueSize || 200;

        // 路由表
        this.routingTable = new Map();
        this.nodeQueue = [];

        // 引导节点 - 使用 IP 地址避免 DNS 解析问题
        this.bootstrapNodes = [
            // 已验证可用的节点（直接使用IP，避免DNS解析延迟和错误）
            { ip: '87.98.162.88', port: 6881 },    // dht.transmissionbt.com - 已验证可用
            { ip: '82.221.103.244', port: 6881 },  // router.utorrent.com
            { ip: '185.157.221.247', port: 6881 }, // dht.libtorrent.org
            { ip: '67.215.246.10', port: 6881 },   // router.bittorrent.com

            // 国内节点（如果可用）
            { ip: '120.78.162.251', port: 6881 },
            { ip: '182.92.170.134', port: 6881 }
        ];

        // 收集的数据
        this.collectedInfoHashes = new Map();
        this.collectedPeers = new Map();

        // 统计
        this.stats = {
            messagesReceived: 0,
            nodesDiscovered: 0,
            infoHashesFound: 0,
            peersFound: 0
        };

        // 回调
        this.onInfoHash = options.onInfoHash || (() => { });
        this.onPeer = options.onPeer || (() => { });
    }

    start() {
        this.socket.bind(this.port, () => {
            console.log(`🕷️  DHT Spider 启动`);
            console.log(`📡 监听端口: ${this.port}`);
            console.log(`🔑 节点 ID: ${this.nodeId.toString('hex')}\n`);

            this.bootstrap();
        });

        this.socket.on('message', (msg, rinfo) => {
            this.handleMessage(msg, rinfo);
        });

        this.socket.on('error', (err) => {
            console.error('Socket 错误:', err.message);
        });

        // 定期清理过期节点
        setInterval(() => this.maintainRouting(), 30000);

        // 定期输出统计
        setInterval(() => this.printStats(), 10000);

        // 主动爬取循环
        setInterval(() => this.crawlNext(), 100);
    }

    bootstrap() {
        console.log('🌐 正在连接引导节点...');
        let sentCount = 0;

        this.bootstrapNodes.forEach(node => {
            console.log(`   📡 Pinging ${node.ip}:${node.port}`);
            this.sendPing(node.ip, node.port);
            sentCount++;
        });

        console.log(`✅ 已发送 ${sentCount} 个 ping 请求`);
    }

    // ==================== 消息发送 ====================

    sendPing(ip, port) {
        const transaction = crypto.randomBytes(2);
        const query = {
            t: transaction,
            y: 'q',
            q: 'ping',
            a: { id: this.nodeId }
        };
        const encoded = bencode(query);
        this.send(encoded, ip, port);
    }

    sendFindNode(ip, port, target) {
        const transaction = crypto.randomBytes(2);
        const query = {
            t: transaction,
            y: 'q',
            q: 'find_node',
            a: { id: this.nodeId, target }
        };
        const encoded = bencode(query);
        this.send(encoded, ip, port);
    }

    sendGetPeers(ip, port, infoHash) {
        const transaction = crypto.randomBytes(2);
        const query = {
            t: transaction,
            y: 'q',
            q: 'get_peers',
            a: { id: this.nodeId, info_hash: infoHash }
        };
        const encoded = bencode(query);
        this.send(encoded, ip, port);
    }

    sendAnnouncePeer(ip, port, infoHash, token, impliedPort = 1) {
        const transaction = crypto.randomBytes(2);
        const query = {
            t: transaction,
            y: 'q',
            q: 'announce_peer',
            a: {
                id: this.nodeId,
                info_hash: infoHash,
                port: this.port,
                token: token,
                implied_port: impliedPort
            }
        };
        this.send(bencode(query), ip, port);
    }

    send(data, ip, port) {
        try {
            this.socket.send(data, port, ip, (err) => {
                if (err) {
                    console.error(`❌ 发送失败 ${ip}:${port}: ${err.message}`);
                }
            });
        } catch (err) {
            console.error(`❌ 发送异常 ${ip}:${port}: ${err.message}`);
        }
    }

    // ==================== 消息处理 ====================

  handleMessage(msg, rinfo) {
    this.stats.messagesReceived++;

    console.log(`📨 收到消息: ${rinfo.address}:${rinfo.port} (${msg.length} bytes)`);

    try {
      const decoded = bdecode(msg);
      if (!decoded) {
        console.log('   ⚠️  bdecode 返回 null');
        return;
      }

      console.log(`   ✅ 解析成功: y=${decoded.y}, q=${decoded.q || 'N/A'}`);

      const key = `${rinfo.address}:${rinfo.port}`;

      if (decoded.y === 'r') {
        this.handleResponse(decoded, rinfo);
      } else if (decoded.y === 'q') {
        this.handleQuery(decoded, rinfo);
      }
    } catch (e) {
      console.log(`   ❌ 解析错误: ${e.message}`);
    }
  }

  handleResponse(resp, rinfo) {
    const key = `${rinfo.address}:${rinfo.port}`;
    console.log(`   📦 响应: ${key}`);

    // 记录响应的节点
    if (this.routingTable.has(key)) {
      const node = this.routingTable.get(key);
      node.lastSeen = Date.now();
    } else {
      // 如果不在路由表，添加进去
      if (resp.r && resp.r.id) {
        const nodeId = Buffer.isBuffer(resp.r.id) ? resp.r.id : Buffer.from(resp.r.id, 'hex');
        this.addNode(nodeId, rinfo.address, rinfo.port);
      }
    }

    if (resp.r && resp.r.nodes) {
      // 发现新节点
      console.log(`   🌱 收到节点列表: ${resp.r.nodes.length} bytes`);
      this.processNodes(resp.r.nodes);
    }

    if (resp.r && resp.r.values) {
      // 发现 peers
      const peers = this.decodePeers(resp.r.values);
      const infoHash = this.routingTable.get(key)?.currentInfoHash;

      console.log(`   👥 收到 ${peers.length} 个 peers`);
      if (infoHash) {
        this.stats.peersFound += peers.length;
        console.log(`🎯 找到 ${peers.length} 个 peer [${infoHash}]`);

        peers.forEach(peer => {
          this.onPeer({ ...peer, infoHash });
        });
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
            const nodes = this.getClosestNodes(target);
            this.sendResponse(rinfo.address, rinfo.port, query.t, { id: this.nodeId, nodes });
        }

        // 响应 get_peers - 收集 announce 的 infohash
        if (query.q === 'get_peers' && query.a && query.a.info_hash) {
            const infoHash = Buffer.isBuffer(query.a.info_hash)
                ? query.a.info_hash.toString('hex')
                : query.a.info_hash;

            if (!this.collectedInfoHashes.has(infoHash)) {
                this.collectedInfoHashes.set(infoHash, {
                    infoHash,
                    firstSeen: Date.now(),
                    peerCount: 0
                });
                this.stats.infoHashesFound++;
                console.log(`📦 新 InfoHash: ${infoHash}`);
                this.onInfoHash(infoHash);
            }

            const token = crypto.randomBytes(4);
            const infoHashBuffer = Buffer.isBuffer(query.a.info_hash) ? query.a.info_hash : Buffer.from(query.a.info_hash, 'hex');
            const nodes = this.getClosestNodes(infoHashBuffer);
            this.sendResponse(rinfo.address, rinfo.port, query.t, {
                id: this.nodeId,
                token,
                nodes
            });
        }

        // 响应 announce_peer
        if (query.q === 'announce_peer' && query.a && query.a.info_hash) {
            const infoHash = Buffer.isBuffer(query.a.info_hash)
                ? query.a.info_hash.toString('hex')
                : query.a.info_hash;

            if (this.collectedInfoHashes.has(infoHash)) {
                const hashData = this.collectedInfoHashes.get(infoHash);
                hashData.peerCount++;
                console.log(`✅ Announce: ${infoHash} (总计: ${hashData.peerCount})`);
            }

            this.sendResponse(rinfo.address, rinfo.port, query.t, { id: this.nodeId });
        }
    }

    sendResponse(ip, port, transaction, data) {
        const resp = {
            t: transaction,
            y: 'r',
            r: data
        };
        this.send(bencode(resp), ip, port);
    }

    // ==================== 节点管理 ====================

    addNode(nodeId, ip, port) {
        const key = `${ip}:${port}`;

        if (this.routingTable.has(key)) {
            const node = this.routingTable.get(key);
            node.lastSeen = Date.now();
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

            // 添加到待爬取队列
            if (this.nodeQueue.length < this.maxQueueSize) {
                this.nodeQueue.push(key);
            }
            return true;
        }

        return false;
    }

  processNodes(nodes) {
    if (!nodes || nodes.length === 0) {
      console.log('   ⚠️  节点列表为空');
      return;
    }

    const nodeCount = Math.floor(nodes.length / 26);
    console.log(`   🔍 解析 ${nodeCount} 个节点...`);

    for (let i = 0; i < nodes.length; i += 26) {
      if (i + 26 > nodes.length) break;

      const id = nodes.slice(i, i + 20);
      const ip = `${nodes[i + 20]}.${nodes[i + 21]}.${nodes[i + 22]}.${nodes[i + 23]}`;
      const port = nodes.readUInt16BE(i + 24);

      const added = this.addNode(id, ip, port);
      if (added) {
        console.log(`      ➕ 新节点: ${ip}:${port}`);
      }
    }

    console.log(`   ✅ 总节点数: ${this.routingTable.size}`);
  }

    decodePeers(values) {
        const peers = [];
        for (let i = 0; i < values.length; i += 6) {
            const ip = `${values[i]}.${values[i + 1]}.${values[i + 2]}.${values[i + 3]}`;
            const port = values.readUInt16BE(i + 4);
            peers.push({ ip, port });
        }
        return peers;
    }

    getClosestNodes(target) {
        const targetBuffer = Buffer.isBuffer(target) ? target : Buffer.from(target, 'hex');
        const nodes = Array.from(this.routingTable.values())
            .map(n => ({
                ...n,
                distance: this.xorDistance(n.id, targetBuffer)
            }))
            .sort((a, b) => a.distance - b.distance)
            .slice(0, 8);

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
        let dist = 0;
        for (let i = 0; i < 20; i++) {
            const b1 = Buffer.isBuffer(id1) ? id1[i] : id1;
            const b2 = Buffer.isBuffer(id2) ? id2[i] : id2;
            dist = (dist << 8) | (b1 ^ b2);
        }
        return dist;
    }

    // ==================== 爬取逻辑 ====================

    crawlNext() {
        if (this.nodeQueue.length === 0) return;

        const key = this.nodeQueue.shift();
        const node = this.routingTable.get(key);
        if (!node) return;

        // 随机生成 infohash 进行查询（爬取模式）
        const randomInfoHash = crypto.randomBytes(20);

        // 记录当前查询的 infohash
        node.currentInfoHash = randomInfoHash.toString('hex');

        this.sendGetPeers(node.ip, node.port, randomInfoHash);
    }

    maintainRouting() {
        const now = Date.now();
        const expired = [];

        this.routingTable.forEach((node, key) => {
            if (now - node.lastSeen > 600000) { // 10分钟过期
                expired.push(key);
            }
        });

        expired.forEach(key => this.routingTable.delete(key));
    }

    // ==================== 统计与输出 ====================

    printStats() {
        console.log('\n📊 统计信息:');
        console.log(`   收到消息: ${this.stats.messagesReceived}`);
        console.log(`   发现节点: ${this.routingTable.size} (新增: ${this.stats.nodesDiscovered})`);
        console.log(`   InfoHash: ${this.collectedInfoHashes.size} (新增: ${this.stats.infoHashesFound})`);
        console.log(`   Peers: ${this.stats.peersFound}`);
        console.log('');

        // 重置统计
        this.stats.nodesDiscovered = 0;
        this.stats.infoHashesFound = 0;
        this.stats.peersFound = 0;
    }

    exportData(filename) {
        const data = {
            infoHashes: Array.from(this.collectedInfoHashes.values()),
            nodes: Array.from(this.routingTable.values()).map(n => ({
                ip: n.ip,
                port: n.port,
                id: n.id.toString('hex')
            }))
        };

        fs.writeFileSync(filename, JSON.stringify(data, null, 2));
        console.log(`💾 数据已导出到 ${filename}`);
    }

    // 主动查询指定 InfoHash 的 Peers
    queryInfoHash(infoHashStr) {
        const infoHash = Buffer.from(infoHashStr, 'hex');
        console.log(`🔍 开始查询 InfoHash: ${infoHashStr}`);

        // 向所有已知节点发送 get_peers
        let sentCount = 0;
        this.routingTable.forEach((node, key) => {
            if (sentCount < 50) { // 限制发送数量
                this.sendGetPeers(node.ip, node.port, infoHash);
                sentCount++;
            }
        });

        console.log(`✅ 已向 ${sentCount} 个节点发送查询`);

        // 如果路由表为空，重新 bootstrap
        if (this.routingTable.size === 0) {
            console.log('⚠️  路由表为空，重新连接引导节点...');
            this.bootstrap();
        }
    }
}

// ==================== bencode 编解码 ====================

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

// ==================== BitWire 协议 - 下载种子元数据 ====================

class MetadataDownloader {
    constructor(infoHash) {
        this.infoHash = Buffer.isBuffer(infoHash) ? infoHash : Buffer.from(infoHash, 'hex');
        this.peerId = crypto.randomBytes(20);
        this.peers = new Map();
        this.pieces = new Map(); // metadata_piece_index -> data
        this.piecesCount = 0;
        this.metadataSize = 0;
        this.completed = false;
    }

    // 解析磁力链接
    static parseMagnet(magnet) {
        const match = magnet.match(/magnet:\?xt=urn:btih:([a-fA-F0-9]{40})/);
        if (!match) {
            throw new Error('无效的磁力链接');
        }
        return match[1];
    }

    // 添加 Peer
    addPeer(ip, port) {
        const key = `${ip}:${port}`;
        if (!this.peers.has(key) && this.peers.size < 20) {
            this.peers.set(key, { ip, port });
            return true;
        }
        return false;
    }

    // 连接单个 Peer 下载元数据
    async downloadFromPeer(peer, timeout = 30000) {
        return new Promise((resolve) => {
            const socket = new net.Socket();
            let connected = false;
            let timer = null;

            const cleanup = () => {
                clearTimeout(timer);
                socket.removeAllListeners();
                try { socket.destroy(); } catch (e) { }
            };

            timer = setTimeout(() => {
                cleanup();
                resolve(null);
            }, timeout);

            socket.on('connect', () => {
                connected = true;
                // 发送握手
                const handshake = Buffer.alloc(68);
                handshake.writeUInt8(19, 0); // protocol length
                handshake.write('BitTorrent protocol', 1); // protocol
                handshake.writeUInt32BE(0, 20); // reserved
                handshake.writeUInt32BE(0, 24); // reserved
                handshake.writeUInt8(0x10, 20); // extension bit
                handshake.writeUInt8(0, 27); // reserved
                this.infoHash.copy(handshake, 28);
                this.peerId.copy(handshake, 48);

                socket.write(handshake);
            });

            socket.on('data', (data) => {
                if (!connected) {
                    // 响应握手
                    const peerInfoHash = data.slice(28, 48);
                    if (peerInfoHash.equals(this.infoHash)) {
                        // 发送 extension handshake
                        const extHandshake = this.buildExtensionHandshake();
                        const message = this.buildMessage(0, extHandshake);
                        socket.write(message);
                    }
                } else {
                    // 处理消息
                    this.handleMessage(data, socket);
                }
            });

            socket.on('error', () => {
                cleanup();
                resolve(null);
            });

            socket.on('close', () => {
                cleanup();
                resolve(null);
            });

            socket.connect(peer.port, peer.ip);
        });
    }

    // 构建扩展握手消息
    buildExtensionHandshake() {
        const handshake = {
            m: {
                ut_metadata: 1
            },
            metadata_size: this.metadataSize || 0
        };
        return bencode(handshake);
    }

    // 构建 BitWire 消息
    buildMessage(extId, payload) {
        const payloadBuffer = Buffer.isBuffer(payload) ? payload : bencode(payload);
        const message = Buffer.alloc(6 + payloadBuffer.length);
        message.writeUInt32BE(2 + payloadBuffer.length, 0); // length
        message.writeUInt8(20, 4); // message type: extension
        message.writeUInt8(extId, 5); // extension id
        payloadBuffer.copy(message, 6);
        return message;
    }

    // 处理接收到的消息
    handleMessage(data, socket) {
        if (data.length < 4) return;

        let offset = 0;
        while (offset < data.length - 4) {
            const length = data.readUInt32BE(offset);
            if (length === 0 || offset + 4 + length > data.length) break;

            const messageType = data[offset + 4];

            if (messageType === 20) { // extension message
                const extId = data[offset + 5];
                const payload = data.slice(offset + 6, offset + 4 + length);

                if (extId === 0) { // extension handshake
                    const dict = bdecode(payload);
                    if (dict.m && dict.m.ut_metadata) {
                        this.metadataSize = dict.metadata_size || 0;
                        this.piecesCount = Math.ceil(this.metadataSize / 16384);
                        // 请求所有分片
                        this.requestAllPieces(socket);
                    }
                } else if (extId === 1) { // ut_metadata
                    this.handleMetadataPiece(payload);
                }
            }

            offset += 4 + length;
        }
    }

    // 请求所有元数据分片
    requestAllPieces(socket) {
        for (let i = 0; i < this.piecesCount; i++) {
            if (!this.pieces.has(i)) {
                this.requestPiece(socket, i);
            }
        }
    }

    // 请求单个分片
    requestPiece(socket, index) {
        const request = bencode({
            msg_type: 0,
            piece: index
        });
        socket.write(this.buildMessage(1, request));
    }

    // 处理收到的元数据分片
    handleMetadataPiece(payload) {
        const dict = bdecode(payload);
        if (dict.msg_type === 1) { // data
            const piece = dict.piece;
            this.pieces.set(piece, Buffer.isBuffer(dict.value) ? dict.value : Buffer.from(dict.value));

            // 检查是否完成
            if (this.pieces.size === this.piecesCount) {
                this.assembleMetadata();
            }
        } else if (dict.msg_type === 2) { // reject
            // 重试其他 peer
        }
    }

    // 组装完整的元数据
    assembleMetadata() {
        this.completed = true;
        const metadata = Buffer.concat(Array.from(this.pieces.values()).sort((a, b) => 0));

        try {
            const info = bdecode(metadata);
            console.log('\n✅ 元数据下载成功!');
            console.log(`📦 名称: ${info.name}`);
            console.log(`📏 大小: ${(info.length || 0) / (1024 * 1024).toFixed(2)} MB`);
            console.log(`📄 文件数: ${info.files ? info.files.length : 1}`);

            // 保存到文件
            const safeName = (info.name || 'metadata').toString().replace(/[^a-zA-Z0-9\-_]/g, '_');
            const filename = `${safeName}.torrent`;
            const torrentData = bencode({ info });
            fs.writeFileSync(filename, torrentData);
            console.log(`💾 已保存到: ${filename}\n`);

            return info;
        } catch (e) {
            console.error('解析元数据失败:', e.message);
            return null;
        }
    }

    // 开始下载
    async start() {
        console.log(`🔍 开始下载元数据: ${this.infoHash.toString('hex')}`);
        console.log(`📡 待连接 Peers: ${this.peers.size}`);

        const peers = Array.from(this.peers.values());

        for (const peer of peers) {
            if (this.completed) break;

            console.log(`🔗 连接 ${peer.ip}:${peer.port}...`);
            await this.downloadFromPeer(peer);

            // 检查进度
            if (this.pieces.size > 0) {
                console.log(`📥 进度: ${this.pieces.size}/${this.piecesCount}`);
            }
        }

        if (!this.completed) {
            console.log('❌ 下载失败，请尝试更多 Peers');
        }

        return this.completed;
    }
}

// ==================== 导出 ====================

module.exports = {
    DHTSpider,
    MetadataDownloader
};

// ==================== 启动爬虫 ====================

// 如果直接运行此文件，启动爬虫模式
if (require.main === module) {
    const spider = new DHTSpider({
        port: 6881,
        maxNodes: 5000,
        onInfoHash: (infoHash) => {
            // 收集到新 InfoHash 时的回调
        },
        onPeer: (peer) => {
            // 收集到新 Peer 时的回调
            if (global.metadataDownloader && !global.metadataDownloader.completed) {
                global.metadataDownloader.addPeer(peer.ip, peer.port);
            }
        }
    });

    spider.start();

    console.log('🕷️  BT DHT Spider 正在运行...');
    console.log('   按 Ctrl+C 停止\n');

    // 示例：下载指定磁力链接的元数据
    /*
    const magnetUrl = 'magnet:?xt=urn:btih:这里替换为40位infohash';
    const infoHash = MetadataDownloader.parseMagnet(magnetUrl);
  
    global.metadataDownloader = new MetadataDownloader(infoHash);
  
    setTimeout(() => {
      spider.queryInfoHash(infoHash);
  
      setTimeout(() => {
        if (global.metadataDownloader.peers.size > 0) {
          global.metadataDownloader.start();
        }
      }, 30000);
    }, 5000);
    */

    process.on('SIGINT', () => {
        console.log('\n正在导出数据...');
        spider.exportData('./dht_data.json');
        process.exit(0);
    });
}
