/**
 * BitTorrent DHT Spider
 * 功能：爬取 InfoHash 和下载磁力元数据
 */

import DHT from 'bittorrent-dht'
import magnet from 'magnet-uri'
import crypto from 'crypto'
import fs from 'fs'
import net from 'net'

class DHTSpider {
  constructor(options = {}) {
    this.dht = new DHT({
      verify: true,
      ...options
    })

    this.port = options.port || 6881
    this.infoHashes = new Map()
    this.peers = new Map()

    this.onInfoHash = options.onInfoHash || (() => {})
    this.onPeer = options.onPeer || (() => {})

    this.dht.on('ready', () => {
      console.log('✅ DHT 就绪')
      console.log(`🔑 节点 ID: ${this.dht.nodeId ? this.dht.nodeId.toString('hex') : 'N/A'}\n`)
    })

    this.dht.on('peer', (peer, infoHash, from) => {
      const hashStr = Buffer.isBuffer(infoHash) ? infoHash.toString('hex') : infoHash

      if (!this.infoHashes.has(hashStr)) {
        this.infoHashes.set(hashStr, {
          infoHash: hashStr,
          firstSeen: Date.now(),
          peerCount: 0
        })
        console.log(`📦 新 InfoHash: ${hashStr.substring(0, 16)}...`)
        this.onInfoHash(hashStr)
      }

      if (!this.peers.has(hashStr)) {
        this.peers.set(hashStr, [])
      }

      this.peers.get(hashStr).push(peer)
      const hashData = this.infoHashes.get(hashStr)
      hashData.peerCount++

      this.onPeer({ ...peer, infoHash: hashStr })
    })

    this.dht.on('error', (err) => {
      const errMsg = err?.message || String(err)
      if (!errMsg.includes('Invalid data') && !errMsg.includes('Unexpected transaction')) {
        console.error('❌ 错误:', errMsg)
      }
    })
  }

  start() {
    console.log('🚀 启动 DHT Spider...\n')
    this.dht.listen(this.port, '0.0.0.0', () => {
      console.log(`📡 监听端口: ${this.port}\n`)
    })

    setInterval(() => this.printStats(), 10000)
  }

  startCrawling() {
    setInterval(() => {
      const randomInfoHash = crypto.randomBytes(20)
      this.dht.announce(randomInfoHash, this.port)
    }, 200)
  }

  async queryInfoHash(infoHashStr) {
    const infoHash = Buffer.from(infoHashStr, 'hex')
    console.log(`\n🔍 查询: ${infoHashStr}`)
    console.log('⏳ 正在查询 Peers... (等待 60 秒)\n')

    return new Promise((resolve) => {
      const foundPeers = []
      const timeout = setTimeout(() => {
        console.log(`✅ 查询完成，找到 ${foundPeers.length} 个 peer`)
        resolve(foundPeers)
      }, 60000)

      const handler = (peer, hash) => {
        const hashStr = Buffer.isBuffer(hash) ? hash.toString('hex') : hash
        const peerInfo = `${peer.host}:${peer.port}`
        if (hashStr === infoHashStr && !foundPeers.some(p => p.host === peer.host && p.port === peer.port)) {
          foundPeers.push(peer)
          console.log(`   🎯 Peer: ${peerInfo}`)
        }
      }

      this.dht.on('peer', handler)
      this.dht.lookup(infoHash)

      setTimeout(() => {
        this.dht.removeListener('peer', handler)
        clearTimeout(timeout)
      }, 60000)
    })
  }

  printStats() {
    const nodes = this.dht._rpc && this.dht._rpc.table ? this.dht._rpc.table.length : 0
    console.log(`\n📊 ${new Date().toLocaleTimeString()}`)
    console.log(`   DHT 节点: ${nodes}`)
    console.log(`   InfoHash: ${this.infoHashes.size}`)
    console.log(`   Peers: ${this.peers.size}`)
  }

  exportData(filename) {
    const data = {
      timestamp: new Date().toISOString(),
      infoHashes: Array.from(this.infoHashes.values()),
      peers: Object.fromEntries(this.peers)
    }
    fs.writeFileSync(filename, JSON.stringify(data, null, 2))
    console.log(`💾 数据已保存: ${filename}`)
  }
}

class MetadataDownloader {
  constructor(infoHash) {
    this.infoHash = Buffer.isBuffer(infoHash) ? infoHash : Buffer.from(infoHash, 'hex')
    this.peerId = crypto.randomBytes(20)
    this.peers = new Map()
    this.pieces = new Map()
    this.piecesCount = 0
    this.metadataSize = 0
    this.completed = false
  }

  static parseMagnet(magnet) {
    const match = magnet.match(/magnet:\?xt=urn:btih:([a-fA-F0-9]{40})/)
    if (!match) {
      throw new Error('无效的磁力链接')
    }
    return match[1]
  }

  addPeer(ip, port) {
    const key = `${ip}:${port}`
    if (!this.peers.has(key) && this.peers.size < 20) {
      this.peers.set(key, { ip, port })
      return true
    }
    return false
  }

  async downloadFromPeer(peer, timeout = 30000) {
    return new Promise((resolve) => {
      const socket = new net.Socket()
      let connected = false
      let timer = null

      const cleanup = () => {
        clearTimeout(timer)
        socket.removeAllListeners()
        try { socket.destroy() } catch (e) {}
      }

      timer = setTimeout(() => {
        cleanup()
        resolve(null)
      }, timeout)

      socket.on('connect', () => {
        connected = true
        const handshake = Buffer.alloc(68)
        handshake.writeUInt8(19, 0)
        handshake.write('BitTorrent protocol', 1)
        handshake.writeUInt32BE(0, 20)
        handshake.writeUInt32BE(0, 24)
        handshake.writeUInt8(0x10, 20)
        handshake.writeUInt8(0, 27)
        this.infoHash.copy(handshake, 28)
        this.peerId.copy(handshake, 48)
        socket.write(handshake)
      })

      socket.on('data', (data) => {
        if (!connected) {
          const peerInfoHash = data.slice(28, 48)
          if (peerInfoHash.equals(this.infoHash)) {
            const extHandshake = this.buildExtensionHandshake()
            const message = this.buildMessage(0, extHandshake)
            socket.write(message)
          }
        } else {
          this.handleMessage(data, socket)
        }
      })

      socket.on('error', () => {
        cleanup()
        resolve(null)
      })

      socket.on('close', () => {
        cleanup()
        resolve(null)
      })

      socket.connect(peer.port, peer.ip)
    })
  }

  buildExtensionHandshake() {
    return Buffer.from(`d1:md11:ut_metadatai1eee6:metadata_sizei${this.metadataSize}e`)
  }

  buildMessage(extId, payload) {
    const payloadBuffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
    const message = Buffer.alloc(6 + payloadBuffer.length)
    message.writeUInt32BE(2 + payloadBuffer.length, 0)
    message.writeUInt8(20, 4)
    message.writeUInt8(extId, 5)
    payloadBuffer.copy(message, 6)
    return message
  }

  handleMessage(data, socket) {
    if (data.length < 4) return

    let offset = 0
    while (offset < data.length - 4) {
      const length = data.readUInt32BE(offset)
      if (length === 0 || offset + 4 + length > data.length) break

      const messageType = data[offset + 4]

      if (messageType === 20) {
        const extId = data[offset + 5]
        const payload = data.slice(offset + 6, offset + 4 + length)

        if (extId === 0) {
          const payloadStr = payload.toString()
          const sizeMatch = payloadStr.match(/metadata_sizei(\d+)e/)
          if (sizeMatch) {
            this.metadataSize = parseInt(sizeMatch[1])
            this.piecesCount = Math.ceil(this.metadataSize / 16384)
            this.requestAllPieces(socket)
          }
        } else if (extId === 1) {
          this.handleMetadataPiece(payload)
        }
      }

      offset += 4 + length
    }
  }

  requestAllPieces(socket) {
    for (let i = 0; i < this.piecesCount; i++) {
      if (!this.pieces.has(i)) {
        this.requestPiece(socket, i)
      }
    }
  }

  requestPiece(socket, index) {
    const request = Buffer.from(`d8:msg_typei0e5:piecei${index}ee`)
    socket.write(this.buildMessage(1, request))
  }

  handleMetadataPiece(payload) {
    const payloadStr = payload.toString()
    const typeMatch = payloadStr.match(/msg_typei(\d+)e/)

    if (typeMatch) {
      const msgType = parseInt(typeMatch[1])

      if (msgType === 1) {
        const pieceMatch = payloadStr.match(/piecei(\d+)e/)
        if (pieceMatch) {
          const piece = parseInt(pieceMatch[1])
          const valueStart = payloadStr.indexOf('ee') + 2
          this.pieces.set(piece, payload.slice(valueStart))

          if (this.pieces.size === this.piecesCount) {
            this.assembleMetadata()
          }
        }
      }
    }
  }

  assembleMetadata() {
    this.completed = true
    const metadata = Buffer.concat(Array.from(this.pieces.values()).sort((a, b) => 0))

    try {
      const info = this.bdecode(metadata)
      console.log('\n✅ 元数据下载成功!')
      console.log(`📦 名称: ${info.name}`)
      const size = info.length || (info.files ? info.files.reduce((sum, f) => sum + f.length, 0) : 0)
      console.log(`📏 大小: ${(size / (1024 * 1024)).toFixed(2)} MB`)
      console.log(`📄 文件数: ${info.files ? info.files.length : 1}`)

      const safeName = (info.name || 'metadata').toString().replace(/[^a-zA-Z0-9\-_]/g, '_')
      const filename = `${safeName}.torrent`
      const torrentData = Buffer.from(`d${this.bencode({ info })}e`)
      fs.writeFileSync(filename, torrentData)
      console.log(`💾 已保存到: ${filename}\n`)

      return info
    } catch (e) {
      console.error('解析元数据失败:', e.message)
      return null
    }
  }

  async start() {
    console.log(`🔍 开始下载元数据: ${this.infoHash.toString('hex')}`)
    console.log(`📡 待连接 Peers: ${this.peers.size}`)

    const peers = Array.from(this.peers.values())

    for (const peer of peers) {
      if (this.completed) break

      console.log(`🔗 连接 ${peer.ip}:${peer.port}...`)
      await this.downloadFromPeer(peer)

      if (this.pieces.size > 0) {
        console.log(`📥 进度: ${this.pieces.size}/${this.piecesCount}`)
      }
    }

    if (!this.completed) {
      console.log('❌ 下载失败，请尝试更多 Peers')
    }

    return this.completed
  }

  bencode(obj) {
    if (typeof obj === 'string') {
      return `${obj.length}:${obj}`
    } else if (typeof obj === 'number') {
      return `i${obj}e`
    } else if (Buffer.isBuffer(obj)) {
      return `${obj.length}:${obj.toString()}`
    } else if (Array.isArray(obj)) {
      return `l${obj.map(this.bencode.bind(this)).join('')}e`
    } else if (typeof obj === 'object' && obj !== null) {
      const keys = Object.keys(obj).sort()
      return `d${keys.map(k => this.bencode(k) + this.bencode(obj[k])).join('')}e`
    }
    return ''
  }

  bdecode(buffer) {
    return this.bdecodeRecursive(buffer)[0]
  }

  bdecodeRecursive(buffer, offset = 0) {
    if (offset >= buffer.length) return [null, offset]

    const char = String.fromCharCode(buffer[offset])

    if (char === 'd') {
      offset++
      const dict = {}
      while (offset < buffer.length && String.fromCharCode(buffer[offset]) !== 'e') {
        const [key, newOffset] = this.bdecodeRecursive(buffer, offset)
        const [value, newerOffset] = this.bdecodeRecursive(buffer, newOffset)
        if (key !== null) dict[key] = value
        offset = newerOffset
      }
      return [dict, offset + 1]
    } else if (char === 'l') {
      offset++
      const list = []
      while (offset < buffer.length && String.fromCharCode(buffer[offset]) !== 'e') {
        const [item, newOffset] = this.bdecodeRecursive(buffer, offset)
        if (item !== null) list.push(item)
        offset = newOffset
      }
      return [list, offset + 1]
    } else if (char === 'i') {
      const end = buffer.indexOf(Buffer.from('e'), offset)
      if (end === -1) return [null, offset]
      return [parseInt(buffer.slice(offset + 1, end).toString()), end + 1]
    } else if (/\d/.test(char)) {
      const colon = buffer.indexOf(':', offset)
      if (colon === -1) return [null, offset]
      const len = parseInt(buffer.slice(offset, colon).toString())
      return [buffer.slice(colon + 1, colon + 1 + len), colon + 1 + len]
    }

    return [null, offset]
  }
}

async function downloadMagnet(magnetUrl, timeout = 180000) {
  console.log(`🎯 目标磁力: ${magnetUrl}\n`)

  try {
    const parsed = magnet(magnetUrl)
    const infoHash = Buffer.isBuffer(parsed.infoHash) ? parsed.infoHash.toString('hex') : parsed.infoHash

    console.log(`🔑 InfoHash: ${infoHash}`)

    const spider = new DHTSpider({
      port: 6881,
      onPeer: (peer) => {
        if (!downloader.completed) {
          downloader.addPeer(peer.host, peer.port)
        }
      }
    })

    spider.start()

    const downloader = new MetadataDownloader(infoHash)

    setTimeout(async () => {
      console.log('\n🔍 开始查询 InfoHash...')
      const peers = await spider.queryInfoHash(infoHash)

      console.log(`\n📥 找到 ${peers.length} 个 Peers`)

      peers.forEach(peer => {
        downloader.addPeer(peer.host, peer.port)
      })

      setTimeout(() => {
        if (downloader.peers.size === 0) {
          console.log('❌ 未找到任何 Peers')
          process.exit(1)
        }

        downloader.start().then(success => {
          process.exit(success ? 0 : 1)
        })
      }, 5000)
    }, 10000)

    setTimeout(() => {
      if (!downloader.completed) {
        console.log('\n⏰ 下载超时')
        process.exit(1)
      }
    }, timeout)

    process.on('SIGINT', () => {
      console.log('\n🛑 正在停止...')
      process.exit(0)
    })

  } catch (error) {
    console.error('❌ 错误:', error.message)
    process.exit(1)
  }
}

export { DHTSpider, MetadataDownloader, downloadMagnet }
export default DHTSpider

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  const spider = new DHTSpider()
  spider.start()
  spider.startCrawling()

  console.log('🕷️  BT DHT Spider 正在运行...')
  console.log('   按 Ctrl+C 停止\n')

  process.on('SIGINT', () => {
    console.log('\n正在导出数据...')
    spider.exportData('./dht_data.json')
    process.exit(0)
  })
}
