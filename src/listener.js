'use strict'

const https = require('https')
const EventEmitter = require('events')
const debug = require('debug')
const log = debug('libp2p:webrtcdirect:listener')
log.error = debug('libp2p:webrtcdirect:listener:error')
const fs = require('fs')

const isNode = require('detect-node')
const wrtc = require('wrtc')
const SimplePeer = require('libp2p-webrtc-peer')
const multibase = require('multibase')
const toString = require('uint8arrays/to-string')
const toMultiaddr = require('libp2p-utils/src/ip-port-to-multiaddr')

const toConnection = require('./socket-to-conn')

module.exports = ({ handler, upgrader }, options = {}) => {
  const listener = new EventEmitter()
  const nodeDomainName = process.env.LIT_NODE_DOMAIN_NAME
  if (!nodeDomainName) {
    throw new Error('LIT_NODE_DOMAIN_NAME env var is not set.  Please set it and make sure you have SSL certs set up for it via certbot in standalone mode.')
  }
  const serverOptions = {
    key: fs.readFileSync(`/etc/letsencrypt/live/${nodeDomainName}/privkey.pem`),
    cert: fs.readFileSync(`/etc/letsencrypt/live/${nodeDomainName}/fullchain.pem`)
  }
  const server = https.createServer(serverOptions)

  let maSelf

  // Keep track of open connections to destroy in case of timeout
  listener.__connections = []

  server.on('request', async (req, res) => {
    res.setHeader('Content-Type', 'text/plain')
    res.setHeader('Access-Control-Allow-Origin', '*')

    const path = req.url
    const incSignalStr = path.split('?signal=')[1]
    const incSignalBuf = multibase.decode(incSignalStr)
    const incSignal = JSON.parse(toString(incSignalBuf))

    options = {
      trickle: false,
      wrtc: isNode ? wrtc : undefined,
      ...options
    }

    const channel = new SimplePeer(options)

    const maConn = toConnection(channel, {
      remoteAddr: toMultiaddr(req.connection.remoteAddress, req.connection.remotePort)
    })
    log('new inbound connection %s', maConn.remoteAddr)

    channel.on('error', (err) => {
      log.error(`incoming connectioned errored with ${err}`)
    })
    channel.once('close', () => {
      channel.removeAllListeners('error')
    })
    channel.on('signal', (signal) => {
      const signalStr = JSON.stringify(signal)
      const signalEncoded = multibase.encode('base58btc', new TextEncoder().encode(signalStr))
      res.end(toString(signalEncoded))
    })

    channel.signal(incSignal)

    let conn
    try {
      conn = await upgrader.upgradeInbound(maConn)
    } catch (err) {
      log.error('inbound connection failed to upgrade', err)
      return maConn.close()
    }
    log('inbound connection %s upgraded', maConn.remoteAddr)

    trackConn(listener, maConn)

    channel.on('connect', () => {
      listener.emit('connection', conn)
      handler(conn)

      channel.removeAllListeners('connect')
      channel.removeAllListeners('signal')
    })
  })

  server.on('error', (err) => listener.emit('error', err))
  server.on('close', () => listener.emit('close'))

  listener.listen = (ma) => {
    maSelf = ma
    const lOpts = ma.toOptions()

    return new Promise((resolve, reject) => {
      server.on('listening', (err) => {
        if (err) {
          return reject(err)
        }

        listener.emit('listening')
        log('Listening on %s %s', lOpts.port, lOpts.host)
        resolve()
      })

      server.listen(lOpts)
    })
  }

  listener.close = async () => {
    if (!server.listening) {
      return
    }

    await Promise.all(listener.__connections.map(c => c.close()))
    return new Promise((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve())
    })
  }

  listener.getAddrs = () => {
    return [maSelf]
  }

  return listener
}

function trackConn (listener, maConn) {
  listener.__connections.push(maConn)

  const untrackConn = () => {
    listener.__connections = listener.__connections.filter(c => c !== maConn)
  }

  maConn.conn.once('close', untrackConn)
}
