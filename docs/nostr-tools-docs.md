
## Usage

### Generating a private key and a public key

```js
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'

let sk = generateSecretKey() // `sk` is a Uint8Array
let pk = getPublicKey(sk) // `pk` is a hex string
```

To get the secret key in hex format, use

```js
import { bytesToHex, hexToBytes } from '@noble/hashes/utils' // already an installed dependency

let skHex = bytesToHex(sk)
let backToBytes = hexToBytes(skHex)
```

### Creating, signing and verifying events

```js
import { finalizeEvent, verifyEvent } from 'nostr-tools/pure'

let event = finalizeEvent({
  kind: 1,
  created_at: Math.floor(Date.now() / 1000),
  tags: [],
  content: 'hello',
}, sk)

let isGood = verifyEvent(event)
```

### Interacting with one or multiple relays

Doesn't matter what you do, you always should be using a `SimplePool`:

```js
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { SimplePool } from 'nostr-tools/pool'

const pool = new SimplePool()

const relays = ['wss://relay.example.com', 'wss://relay.example2.com']

// let's query for one event that exists
const event = pool.get(
  relays,
  {
    ids: ['d7dd5eb3ab747e16f8d0212d53032ea2a7cadef53837e5a6c66d42849fcb9027'],
  },
)
if (event) {
  console.log('it exists indeed on this relay:', event)
}

// let's query for more than one event that exists
const events = pool.querySync(
  relays,
  {
    kinds: [1],
    limit: 10
  },
)
if (events) {
  console.log('it exists indeed on this relay:', events)
}

// let's publish a new event while simultaneously monitoring the relay for it
let sk = generateSecretKey()
let pk = getPublicKey(sk)

pool.subscribe(
  ['wss://a.com', 'wss://b.com', 'wss://c.com'],
  {
    kinds: [1],
    authors: [pk],
  },
  {
    onevent(event) {
      console.log('got event:', event)
    }
  }
)

let eventTemplate = {
  kind: 1,
  created_at: Math.floor(Date.now() / 1000),
  tags: [],
  content: 'hello world',
}

// this assigns the pubkey, calculates the event id and signs the event in a single step
const signedEvent = finalizeEvent(eventTemplate, sk)
await Promise.any(pool.publish(['wss://a.com', 'wss://b.com'], signedEvent))

relay.close()
```

To use this on Node.js you first must install `ws` and call something like this:

```js
import { useWebSocketImplementation } from 'nostr-tools/pool'
// or import { useWebSocketImplementation } from 'nostr-tools/relay' if you're using the Relay directly

import WebSocket from 'ws'
useWebSocketImplementation(WebSocket)
```

#### enablePing

You can enable regular pings of connected relays with the `enablePing` option. This will set up a heartbeat that closes the websocket if it doesn't receive a response in time. Some platforms, like Node.js, don't report websocket disconnections due to network issues, and enabling this can increase the reliability of the `onclose` event.

```js
import { SimplePool } from 'nostr-tools/pool'

const pool = new SimplePool({ enablePing: true })
```

#### enableReconnect

You can also enable automatic reconnection with the `enableReconnect` option. This will make the pool try to reconnect to relays with an exponential backoff delay if the connection is lost unexpectedly.

```js
import { SimplePool } from 'nostr-tools/pool'

const pool = new SimplePool({ enableReconnect: true })
```

Using both `enablePing: true` and `enableReconnect: true` is recommended as it will improve the reliability and timeliness of the reconnection (at the expense of slighly higher bandwidth due to the ping messages).

```js
// on Node.js
const pool = new SimplePool({ enablePing: true, enableReconnect: true })
```

The `enableReconnect` option can also be a callback function which will receive the current subscription filters and should return a new set of filters. This is useful if you want to modify the subscription on reconnect, for example, to update the `since` parameter to fetch only new events.

```js
const pool = new SimplePool({
  enableReconnect: (filters) => {
    const newSince = Math.floor(Date.now() / 1000)
    return filters.map(filter => ({ ...filter, since: newSince }))
  }
})
```


### Querying profile data from a NIP-05 address

```js
import { queryProfile } from 'nostr-tools/nip05'

let profile = await queryProfile('jb55.com')
console.log(profile.pubkey)
// prints: 32e1827635450ebb3c5a7d12c1f8e7b2b514439ac10a67eef3d9fd9c5c68e245
console.log(profile.relays)
// prints: [wss://relay.damus.io]
```
