hypercore-upload-server
=======================

> File ingestion with Hypercore over WebSockets

## Installation

```sh
$ npm install hypercore-upload-server
```

## Example

### Server

See [example/server.js](example/server.js)

### Client

See [example/client.js](example/client.js)

## Usage

```js
const { Server } = require('hypercore-upload-server')
const path = require('path')
const raf = require('random-access-file')

const dataDir = '/path/to/data/dir'

const server = new Server({
  // storage for Corestore and it's Hypercore instances
  storage(filename) {
    return raf(path.reolve(dataDir, filename))
  },

  // write uploaded chunks somewhere, like S3, the filesystem, or a Hyperdrive
  onwrite(key, offset, buffer, metadata, callback) {
    const filename = path.resolve(data, metadata.name)
    touch(filename, (err) => {
      if (err) { return callback(err) }
      fs.open(filename, fs.constants.O_RDWR | fs.constants.O_CREAT, (err, fd) => {
        if (err) { return callback(err) }
        fs.write(fd, buffer, 0, buffer.length, offset, (err) => {
          if (err) { return callback(err) }
          fs.close(fd, callback)
        })
      })
    })
  }
})
```

## API

### `server = new Server(opts)`

Create a new `Server` for hypercore uploads over websockets where `opts`
can be:

```js
{
  corestore: null, // a corestore for a hypercore/hypertrie factory
  storage: null // an optional random access storage factory for a `Corestore` instance
  onwrite: (key, offset, data, metadata, callback) => { ... }, // called when data for a key at an offset needs to be written
  gc: {
    timeout: 5 * 1000 // timeout in milliseconds before a worker thread GC's any resources
  }
}
```

See [`example/server.js`](example/server.js) for a complete example.


#### `server.listen(port[, host[, callback]])`

Listen on a given `port` an optional `host` calling `callback(err)` upon
error or success.

## License

MIT
