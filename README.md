hypercore-upload-server
=======================

> (WIP) File ingestion with Hypercore over WebSockets

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

> TODO

#### `server.listen(port[, host[, callback]])`

> TODO

## License

MIT
