const multipart = require('hypercore-multipart')
const Corestore = require('corestore')
const WebSocket = require('simple-websocket')
const blake2b = require('blake2b')
const crypto = require('crypto')
const Batch = require('batch')
const pump = require('pump')
const path = require('path')
const raw = require('random-access-web')
const ram = require('random-access-memory')
const raf = require('random-access-blob/file')

const {
  METADATA_EXTENSION,
  SIGNAL_EXTENSION,
  KEY_EXTENSION
} = require('../extension')

document.body.style['background-color'] = 'rgb(228, 232, 239)'
document.body.style['font-family'] = 'sans-serif'

document.body.innerHTML = `
  <input type="file" onchange="onfile(event)" style="height: 25px;background-color: rgb(63, 114, 195);padding-top: 5px;padding-left: 5px;border-radius: 2px;border-top: 4px solid rgb(66, 135, 245);display: inline-block;vertical-align: middle;" />
  <span id="progress" style="border-radius: 2px; border-top: 4px solid rgb(63, 114, 195); background-color: #4287f5;display: inline-block;height: 25px; width: 0; max-width: 256px; transition: all ease-out 10ms;text-align: center; vertical-align: middle; padding-top: 5px;"></span>
`

Object.assign(global, { onfile })

function connect(pathspec) {
  return new WebSocket(`ws://localhost:3000${pathspec}`)
}

function onfile(event) {
  const progress = document.querySelector('#progress')
  const [ file ] = event.target.files
  progress.innerHTML = ''
  upload(file, (err) => {
    if (err) { throw err }
    progress.innerHTML = 'Done'
    event.target.value = ''
  })
}

function upload(file, callback) {
  // don't write to storage, just index data (generate tree, signatures, bitfield)
  const corestore = new Corestore(createStorage, { indexing: true })
  const storage = raf(file)

  const bufferSize = 2 * 1024 * 1024
  const pageSize = 64 * 1024 * 1024

  // metadata sent to the server before ingestion
  const metadata = {
    bufferSize,
    pageSize,
    name: file.name,
    size: file.size,
    type: file.type
  }

  // we'll report progress to this DOM element
  const progress = document.querySelector('#progress')

  // unique ID for this upload context
  const id = crypto.randomBytes(16).toString('hex')

  let totalUploadedBytes = 0
  let totalUploadLength = 0
  let totalIndexed = 0
  let currentPage = 0
  let ingestion = null
  let context = null

  corestore.ready(onready)

  function createStorage(filename) {
    const basename = path.basename(filename)
    if ('data' === basename) {
      // first data storage is for the "default" feed from corestore ^
      // we call that "context" here
      if (0 === currentPage) {
        ++currentPage
      } else {
        // return new storage for each partition
        const offset = pageSize * (currentPage - 1)
        ++currentPage
        return raf(file, { offset })
      }
    }

    // this could be 'random-access-web' to persist between page loads
    return raw('hus')(id + filename)
  }

  function read(offset, length, callback) {
    storage.read(offset, length, callback)
  }

  function stat(callback) {
    storage.stat(callback)
  }

  function uploadPartition(page, feed, done) {
    // start replicating page feed with server, the entire feed is
    // an indexed hypercore feed, bytes are indexed (signed, hashed)
    // and then read from storage to the server
    const socket = connect(`/${context.key.toString('hex')}/${page}`)

    socket.on('connect', () => {
      const stream = feed.replicate(true, { ack: true })

      let uploadedBytes = 0

      feed.on('upload', (index, buffer) => {
        uploadedBytes += buffer.length
        totalUploadedBytes += buffer.length

        if (uploadedBytes === feed.byteLength) {
          stream.finalize()
        }

        const percentage = `${Math.floor(100 *(totalUploadedBytes/totalUploadLength))}%`
        progress.style.width = percentage
        progress.textContent = `Uploading ${percentage}`
      })

      pump(socket, stream, socket, done)
    })
  }

  function onready(err) {
    if (err) { return callback(err) }

    // the default feed for this upload, we'll use its public key
    // for the upload key
    context = corestore.default()
    context.ready((err) => {
      if (err) { return callback(err) }
      // before we can ingest, we need to create a context and get a master key
      // for the multipart ingestion
      const socket = connect(`/${context.key.toString('hex')}`)

      socket.once('connect', () => {
        console.log('connect');
        // stream context for this ingestion, we want acks and the connection
        // to be kept alive and to replicate corestore with initial feed (empty)
        const stream = corestore.replicate(true, { ack: true, live: true })

        pump(socket, stream, socket)

        // register `KEY_EXTENSION` to listen for incoming master key for ingestion
        stream.registerExtension(KEY_EXTENSION, {
          onmessage(message) {
            // send metadata payload to server
            console.log('got master key', message.toString('hex'))
            onmasterkey(message)
          }
        })

        // register `METADATA_EXTENSION` to send JSON metadata about the ingestion
        stream.registerExtension(METADATA_EXTENSION, { encoding: 'json' }).send(metadata)
      })
    })
  }

  function onmasterkey(masterKey) {
    // ingestion options to configure the buffer and page size as well
    // as stream bytes from a file on the user's system from `FileReader`
    // in random-access-blob
    const ingestionOptions = {
      bufferSize,
      masterKey,
      corestore,
      pageSize,
      onpage,
      read,
      stat
    }

    progress.textContent = 'Indexing 0%'
    // partition file into several hypercores of no more
    // than `pageSize` bytes (feed.byteLength)
    ingestion = multipart(ingestionOptions, oningestion)
  }

  function onpage(page, feed) {
    ++totalIndexed

    const percentage = `${Math.floor(100 * (totalIndexed/ingestion.pages))}%`
    progress.style.width = percentage
    progress.textContent = `Indexing ${percentage}`
  }

  function oningestion(err, partitions) {
    if (err) { return callback(err) }

    const batch = new Batch()

    totalUploadLength = partitions.map((p) => p.byteLength).reduce((a, b) => a + b, 0)

    batch.concurrency(4)

    for (let i = 0; i < partitions.length; ++i) {
      batch.push((next) => uploadPartition(i + 1, partitions[i], next))
    }

    batch.end(oncomplete)
  }

  function oncomplete(err) {
    if (err) { return callback(err) }
    // before we can ingest, we need to create a context and get a master key
    // for the multipart ingestion
    const socket = connect(`/${context.key.toString('hex')}`)

    socket.on('connect', () => {
      // stream context for this ingestion, we want acks and the connection
      // to be kept alive and to replicate corestore with initial feed (empty)
      const stream = corestore.replicate(true, { ack: true })

      pump(socket, stream, socket, callback)

      // register `SIGNAL_EXTENSION` to send JSON metadata about the ingestion
      stream.registerExtension(SIGNAL_EXTENSION, { encoding: 'json' }).send({
        complete: true
      })
    })
  }
}
