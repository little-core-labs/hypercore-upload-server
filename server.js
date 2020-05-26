const { EventEmitter } = require('events')
const { keyPair } = require('hypercore-multipart')
const hypertrie = require('hypertrie')
const Corestore = require('corestore')
const Protocol = require('hypercore-protocol')
const crypto = require('hypercore-crypto')
const extend = require('extend')
const mutex = require('mutexify')
const debug = require('debug')('hypercore-upload-server')
const Batch = require('batch')
const path = require('path')
const pump = require('pump')
const Pool = require('piscina')
const http = require('http')
const ram = require('random-access-memory')
const url = require('url')
const ws = require('ws')

const {
  METADATA_EXTENSION,
  SIGNAL_EXTENSION,
  KEY_EXTENSION,
  NAMESPACE
} = require('./extension')

/**
 * Default WebSocket max message payload size
 * @private
 */
const DEFAULT_MAX_PAYLOAD = 32 * 1024 * 1024

/**
 * Bad request websocket error code
 * @private
 */
const WS_BAD_REQUEST = 1007

/**
 * Internal error web socket error code.
 * @private
 */
const WS_INTERNAL_ERROR = 1011

/**
 * Error message for missing master key in web socket connection.
 * @private
 */
const WS_REASON_MISSING_MASTER_KEY = "Missing master key for this context."

/**
 * Error message for missing invalid context key in web socket connection.
 * @private
 */
const WS_REASON_INVALID_CONTEXT_KEY_LENGTH = "Invalid context key length. Expecting 32 byte hex string."

/**
 * Error message for missing metadata in web socket connection.
 * @private
 */
const WS_REASON_MISSING_METADATA = "Missing metadata in context."

/**
 * Error message for a bad feed audit in web socket connection.
 * @private
 */
const WS_REASON_AUDIT_FAILED = "Audit failed. Rejecting feed."

/**
 * Error message for a general bad request in web socket connection.
 * @private
 */
const WS_REASON_BAD_REQUEST = "Bad request."

/**
 * Error message for a general bad request in web socket connection.
 * @private
 */
const WS_REASON_INTERNAL_ERROR = "An unknown internal error has occured."

/**
 * A garbage collector to remove dead files from the file system.
 * @private
 */
class GarbageCollector {

  /**
   * `GarbageCollector` class constructor.
   */
  constructor(server, opts) {
    this.ontimeout = this.ontimeout.bind(this)
    this.timeout = opts.timeout
    this.server = server
    this.queue = new Set()
    this.timer = null
    this.lock = mutex()
    this.pool = new Pool({
      filename: path.resolve(__dirname, 'worker', 'gc.js')
    })

    this.init()
  }

  /**
   * Called when the GC timer has run out.
   */
  ontimeout() {
    this.collect((err) => {
      if (err) {
        debug(err)
      }

      this.init()
    })
  }

  /**
   * Initalizes the garbages collector, reseting state.
   */
  init(callback) {
    this.timer = setTimeout(this.ontimeout, this.timeout)
  }

  /**
   * Add a path to the queue for GC.
   */
  add(path) {
    this.queue.add(path)
  }

  /**
   * Remove a path from the queue for GC.
   */
  remove(path) {
    this.queue.delete(path)
  }

  /**
   * Reset the GC state.
   */
  reset() {
    clearTimeout(this.timer)
    this.queue.clear()
    this.timer = null
  }

  /**
   * Spawn worker thread to do GC.
   */
  collect(callback) {
    this.lock((release) => {
      const queue = Array.from(this.queue)
      this.reset()
      this.pool.runTask({ queue })
        .then(() => release(callback))
        .then((() => this.init()))
        .catch((err) => release(callback, err))
    })
  }
}

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
      storage: ram,
      workers: { write: null },
      ws: { maxPayload: DEFAULT_MAX_PAYLOAD, },
      gc: { timeout: 5 * 1000 }
    }
  }

  /**
   * `Server` class constructor.
   * @constructor
   * @param {Object} opts
   * @param {?(Corestore)} opts.corestore
   * @param {?(Function)} opts.storage
   * @param {?(String)} opts.path
   */
  constructor(opts) {
    super()

    opts = extend(true, this.constructor.defaults(), opts)

    let corestore = null

    if (opts.corestore) {
      corestore = opts.corestore.namespace(this.constructor.NAMESPACE)
    } else {
      corestore = new Corestore(opts.storage)
    }

    this.discoveryKey = opts.discoveryKey || crypto.randomBytes(32)
    this.corestore = corestore
    this.options = opts
    this.server = opts.server || http.createServer()
    this.trie = null
    this.wss = null
    this.gc = new GarbageCollector(this, opts.gc)

    this.onconnection = this.onconnection.bind(this)

    this.corestore.ready((err) => {
      if (err) { this.emit('error', err) }
      const feed = this.corestore.default()
      this.trie = hypertrie(null, { feed })
    })
  }

  /**
   * Save JSON metadata for a session key.
   * @protected
   */
  saveMetadata(key, metadata, callback) {
    const trieKey = `${NAMESPACE}/${key}/metadata`
    const trieValue = Buffer.from(JSON.stringify(metadata))
    this.trie.put(trieKey, trieValue, callback)
  }

  /**
   * Get JSON metadata for a session key.
   * @protected
   */
  getMetadata(key, callback) {
    const trieKey = `${NAMESPACE}/${key}/metadata`
    this.trie.get(trieKey, (err, res) => {
      if (err) {
        callback(err)
      } else if (res.value) {
        try {
          const metadata = JSON.parse(res.value)
          callback(null, metadata)
        } catch (err) {
          callback(err)
        }
      } else {
        callback(null, null)
      }
    })
  }

  /**
   * Save a master key for the session key.
   * @protected
   */
  saveMasterKey(key, masterKey, callback) {
    const trieKey = `${NAMESPACE}/${key}`
    this.trie.put(trieKey, masterKey, callback)
  }

  /**
   * Get a master key for the session key.
   * @protected
   */
  getMasterKey(key, callback) {
    const trieKey = `${NAMESPACE}/${key}`
    this.trie.get(trieKey, (err, res) => {
      if (err) {
        callback(err)
      } else if (res) {
        callback(null, res.value || null)
      } else {
        callback(null, null)
      }
    })
  }

  /**
   * Handles incoming WebSocket connections.
   * @private
   * @param {WebSocket} socket
   * @param {http.IncomingMessage} request
   */
  onconnection(socket, request) {
    const { pathname } = url.parse(request.url)
    const params = pathname.split('/').filter(Boolean).reverse().slice(0, 3).reverse()

    // /<key>/[contextAction|partitionNumber]/[partitionAction]
    const [ key, contextActionOrPartition, partitionAction ] = params

    if (!key || 64 !== key.length) {
      socket.close(WS_BAD_REQUEST, WS_REASON_INVALID_CONTEXT_KEY_LENGTH)
      return
    }

    const partitionNumber = parseInt(contextActionOrPartition) || Number.NaN
    const contextAction = contextActionOrPartition

    try {
      if (Number.isNaN(partitionNumber)) {
        this.oncontext(socket, request, key, contextAction)
      } else if (partitionNumber) {
        this.onpartition(socket, request, key, partitionNumber, partitionAction)
      } else {
        socket.close(WS_BAD_REQUEST, WS_REASON_BAD_REQUEST)
      }
    } catch (err) {
      debug(err)
      this.emit('error', err)
    }
  }

  /**
   * Called when a new context connection is made.
   * @private
   */
  oncontext(socket, request, key, action) {
    const { options, trie } = this
    const connection = ws.createWebSocketStream(socket)
    const extensions = {}

    this.getMasterKey(key, (err, masterKey) => {
      if (err) {
        return (debug(err), socket.close(WS_INTERNAL_ERROR))
      }

      if (!masterKey) {
        masterKey = crypto.randomBytes(32)
      }

      const publicKey = Buffer.from(key, 'hex')
      const stream = new Protocol(false, { ack: true, live: true })

      const channel = stream.open(publicKey)

      stream.once('error', (err) => {
        debug(err)
        socket.close(WS_INTERNAL_ERROR)
      })

      pump(stream, connection, stream)

      this.saveMasterKey(key, masterKey, (err) => {
        if (err) {
          return (debug(err), socket.close(WS_INTERNAL_ERROR))
        }
      })

      // register `KEY_EXTENSION` to send a randomly generated master key
      // for this ingestion session
      stream.registerExtension(KEY_EXTENSION).send(masterKey)

      // register `SIGNAL_EXTENSION` to send a randomly generated master key
      // for this ingestion session
      stream.registerExtension(SIGNAL_EXTENSION, {
        encoding: 'json',
        onmessage(signal) {
          if (signal && signal.complete) {
            socket.close()

            if ('function' === typeof options.oncomplete) {
              options.oncomplete(key, metadata)
            }
          }
        }
      })

      // register `METADATA_EXTENSION` to listen for incoming JSON metadata
      // about the ingestion that we store in the trie
      stream.registerExtension(METADATA_EXTENSION, {
        encoding: 'json',
        onmessage: (metadata) => {
          this.saveMetadata(key, metadata, (err) => {
            if (err) {
              return (debug(err), socket.close(WS_INTERNAL_ERROR))
            }

            socket.close()
          })
        }
      })
    })
  }

  /**
   * Called when a new connection with a partition is made.
   * @private
   */
  onpartition(socket, request, key, page, action) {
    const { corestore, options, trie, gc } = this
    const connection = ws.createWebSocketStream(socket)

    return this.getMasterKey(key, (err, masterKey) => {
      if (err) {
        return (debug(err), socket.close(WS_INTERNAL_ERROR))
      }

      if (!masterKey) {
        return socket.close(WS_BAD_REQUEST, WS_REASON_MISSING_MASTER_KEY)
      }

      this.getMetadata(key, (err, metadata) => {
        if (err) {
          return (debug(err), socket.close(WS_INTERNAL_ERROR))
        }

        if (!metadata) {
          return socket.close(WS_BAD_REQUEST, WS_REASON_MISSING_METADATA)
        }

        oncontext({ masterKey, metadata })
      })
    })

    function oncontext({ masterKey, metadata }) {
      const { bufferSize, pageSize } = metadata
      const { publicKey } = keyPair({ masterKey, pageSize, page })
      const feed = corestore.get({ onwrite, key: publicKey })
      const stream = feed.replicate(false, { ack: true })

      let closed = false
      let dirname = null

      feed.ready(onready)
      feed.once('sync', onsync)
      stream.once('error', onerror)

      socket.once('close', onclose)

      return pump(connection, stream, connection)

      function clear(index, done) {
        for (const channel of stream.channels) {
          channel.unwant({ start: index, length: 1 })
        }

        feed.clear(index, done)
      }

      function onerror(err) {
        debug(err)
        socket.close(WS_INTERNAL_ERROR, err.code || WS_REASON_INTERNAL_ERROR)
      }

      function onclose() {
        if (closed) { return }
        closed = true
        if (dirname) {
          gc.add(dirname)
          if (feed) {
            feed.destroyStorage()
          }
        }
      }

      function onwrite(index, data, peer, done) {
        if ('function' !== typeof options.onwrite) {
          return clear(index, done)
        }

        const offset = ((page - 1) * pageSize) + (index * bufferSize)
        options.onwrite(key, offset, data, metadata, (err) => {
          if (err) {
            done(err)
          } else {
            clear(index, done)
          }
        })
      }

      function onready(err) {
        if (err) {
          return onerror(err)
        } else if (feed._storage) {
          if (feed._storage.data && feed._storage.data.filename) {
            dirname = path.dirname(feed._storage.data.filename)
          }
        }
      }

      function onsync() {
        feed.audit(onaudit)
      }

      function onaudit(err, report) {
        if (err) {
          return (debug(err), socket.close(WS_INTERNAL_ERROR))
        }

        if (report.invalid > 0) {
          socket.close(WS_BAD_REQUEST, WS_REASON_AUDIT_FAILED)
        } else {
          setTimeout(() => socket.close(), 100)
        }

        if (dirname) {
          gc.add(dirname)
          feed.destroyStorage()
        }
      }
    }
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
        //maxPayload: this.options.ws.maxPayload,
        server: this.server,
        path: this.options.ws.path,
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

    close.end((err) => {
      this.wss = null
      this.server = null

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
