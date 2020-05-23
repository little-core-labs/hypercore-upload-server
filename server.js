const { EventEmitter } = require('events')
const { keyPair } = require('hypercore-multipart')
const Networking = require('corestore-swarm-networking')
const hypertrie = require('hypertrie')
const Corestore = require('corestore')
const Protocol = require('hypercore-protocol')
const crypto = require('hypercore-crypto')
const extend = require('extend')
const rimraf = require('rimraf')
const debug = require('debug')('hypercore-upload-server')
const Batch = require('batch')
const path = require('path')
const pump = require('pump')
const http = require('http')
const ram = require('random-access-memory')
const raf = require('random-access-file')
const ws = require('ws')

/**
 * Default WebSocket max message payload size
 * @private
 */
const DEFAULT_MAX_PAYLOAD = 9 * 1024 * 1024

/**
 * The `Server` class is a container for a HTTP WebSocket server listening for
 * incoming connections that implement the Hypercore protocol. Incoming connections
 * are considered data to be ingested as `hypercore-multipart` feeds.
 * @public
 * @class Server
 * @extends EventEmitter
 */
class Server extends EventEmitter {

  /**
   * Default options for the `Server` constructor.
   * @static
   */
  static defaults() {
    return {
      maxPayload: DEFAULT_MAX_PAYLOAD,
      storage: ram,
    }
  }

  /**
   * The extension and corestore namespace for this server.
   * @static
   * @accessor
   * @type {String}
   */
  static get NAMESPACE() {
    return 'hus'
  }

  /**
   * The metadata extension for the hypercore protocol used by this server.
   * This name is derived from the `NAMESPACE` static accessor.
   * @static
   * @accessor
   * @type {String}
   */
  static get METADATA_EXTENSION() {
    return `${this.NAMESPACE}/metadata`
  }

  /**
   * The master key extension for the hypercore protocol used by this server.
   * This name is derived from the `NAMESPACE` static accessor.
   * @static
   * @accessor
   * @type {String}
   */
  static get KEY_EXTENSION() {
    return `${this.NAMESPACE}/key`
  }

  /**
   * `Server` class constructor.
   * @constructor
   * @param {Object} opts
   * @param {?(Corestore)} opts.corestore
   * @param {?(Function)} opts.storage
   * @param {?(Number)} opts.maxPayload
   * @param {?(String)} opts.path
   */
  constructor(opts) {
    super()

    opts = extend(true, this.constructor.defaults(), opts)

    this.storage = opts.storage
    this.onwrite = opts.onwrite || null
    this.discoveryKey = opts.discoveryKey || crypto.randomBytes(32)
    this.corestore = opts.corestore || new Corestore(opts.storage)
    this.networking = new Networking(this.corestore)
    this.server = http.createServer()
    this.maxPayload = opts.maxPayload
    this.path = opts.path
    this.trie = null
    this.wss = null

    this.onconnection = this.onconnection.bind(this)

    this.corestore.ready((err) => {
      if (err) { this.emit('error', err) }
      const feed = this.corestore.namespace(this.constructor.NAMESPACE).default()
      this.trie = hypertrie(null, { feed })
      this.networking.join(this.discoveryKey)
    })
  }

  /**
   * Handles incoming WebSocket connections.
   * @private
   * @param {WebSocket} socket
   * @param {http.IncomingMessage} request
   */
  onconnection(socket, request) {
    const { METADATA_EXTENSION, KEY_EXTENSION } = this.constructor
    const { corestore, storage, onwrite, trie } = this

    corestore.ready((err) => {
      if (err) {
        this.emit('error', err)
        socket.close(1011)
        return
      }

      let [ page, key ] = request.url.split('/').reverse().filter(Boolean)
      let masterKey = null
      let channel = null

      if (page && 64 === page.length) {
        key = page
        page = Number.NaN
      } else {
        page = parseInt(page) || Number.NaN
      }

      if (!key || 64 !== key.length) {
        return socket.close(1007)
      }

      const connection = ws.createWebSocketStream(socket)
      const protocol = new Protocol(false, { onchannelclose, live: true })

      pump(connection, protocol, connection)

      // master key acquisition
      if (key && Number.isNaN(page)) {
        trie.get(key, (err, res) => {
          masterKey = res && res.value ? res.value : crypto.randomBytes(32)

          trie.put(key, masterKey, (err) => {
            if (err) {
              this.emit('error', err)
              socket.close(1011)
              return
            }

            channel = protocol.open(Buffer.from(key, 'hex'))

            protocol.registerExtension(KEY_EXTENSION).send(masterKey)
            protocol.registerExtension(METADATA_EXTENSION, {
              encoding: 'json',
              onmessage: onmetadata
            })
          })
        })
      } else if (key && false === Number.isNaN(page) && page > 0) {
        trie.get(key, (err, res) => {
          if (err) {
            this.emit('error', err)
            socket.close(1011)
            return
          }

          masterKey = res.value

          const { publicKey } = keyPair({ masterKey, page })
          const feed = corestore.get({ key: publicKey })

          channel = protocol.open(Buffer.from(key, 'hex'))

          feed.replicate(false, { stream: protocol, live: true })

          feed.once('sync', () => {
            channel.close()

            const file = storage(key)
            const feeds = []

            if ('function' !== typeof onwrite) {
              try {
                const dirname = path.dirname(feed._storage.data.filename)
                rimraf(dirname, (err) => err && debug(err))
              } catch (err) {
                debug(err)
              }
            } else {
              const ready = new Batch()

              for (let i = 0; i < page - 1; ++i) {
                const key = keyPair({ masterKey, page: i + 1 }).publicKey
                feeds.push(corestore.get({ key }))
                ready.push((next) => feed.ready(next))
              }

              ready.end((err) => {
                if (err) {
                  this.emit('error', err)
                  socket.close(1011)
                  return
                }

                const offset = feeds
                  .slice(0, page)
                  .map((feed) => feed.byteLength)
                  .reduce((a, b) => a + b, 0)

                trie.get(`${key}/metadata`, (err, res) => {
                  if (err) {
                    this.emit('error', err)
                    socket.close(1011)
                    return
                  }

                  let metadata = {}

                  try {
                    metadata = JSON.parse(res.value)
                  } catch (err) {
                    debug(err)
                  }

                  onwrite(masterKey, offset, feed.byteLength, feed, metadata, (err) => {
                    if (err) {
                      this.emit('error', err)
                      socket.close(1011)
                      return
                    }

                    try {
                      const dirname = path.dirname(feed._storage.data.filename)
                      rimraf(dirname, (err) => err && debug(err))
                    } catch (err) {
                      debug(err)
                    }

                    socket.close()
                  })
                })
              })
            }
          })
        })
      }

      function onmetadata(metadata) {
        const { size, parts } = metadata
        const feeds = []
        const ready = new Batch()

        let missing = parts

        for (let i = 0; i < parts; ++i) {
          const key = keyPair({ masterKey, page: i + 1 }).publicKey
          feeds.push(corestore.get({ key }))
        }

        for (const feed of feeds) {
          ready.push((next) => feed.ready(next))
          if (feed.length && feed.length === feed.downloaded()) {
            missing--
          } else {
            feed.once('sync', () => {
              missing--
              poll()
            })
          }
        }

        ready.end(poll)

        function poll() {
          if (0 === missing) {
            metadata.key = key
            metadata.keys = feeds.map((feed) => feed.key.toString('hex'))
            trie.put(`${key}/metadata`, JSON.stringify(metadata))
            channel.close()
          }
        }
      }

      function onchannelclose() {
        connection.end()
        socket.close()
      }
    })
  }

  /**
   * Returns the HTTP server address information
   * @return {Object}
   */
  address() {
    return this.server.address()
  }

  /**
   * Starts the HTTP server listening for incoming connections with a bound
   * WebSocket server.
   * @param {Number} port
   * @param {?(String} host
   * @param {?(Function} callback
   * @see {@link https://nodejs.org/api/http.html#http_server_listen}
  */
  listen(...args) {
    if (!this.wss) {
      this.server.listen(...args)
      this.wss = new ws.Server({
        maxPayload: this.maxPayload,
        server: this.server,
        path: this.path,
      })

      this.wss.on('connection', this.onconnection)
    }
  }

  /**
   * Closes opened resources calling `callback(err)` upon error
   * or success
   * @param {?(Function)} callback
   */
  close(callback) {
    const closing = new Batch()

    if (this.wss) {
      this.wss.removeListener('connection', this.onconnection)
      closing.push((next) => this.wss.close(next))
    }

    if (this.server) {
      closing.push((next) => this.server.close(next))
    }

    if (this.networking) {
      closing.push((next) => this.networking.close(next))
    }

    close.end((err) => {
      this.wss = null
      this.server = null
      this.networking = null
      if ('function' === typeof callback) {
        callback(err)
      }
    })
  }
}

/**
 * Module exports.
 */
module.exports = {
  Server
}
