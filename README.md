# @ncd-io/wireless-comms

Communication classes for NCD wireless devices: two byte-pipe transports and the DigiMesh frame
parser that runs on top of them.

This package is the successor to [`ncd-red-comm`](https://github.com/ncd-io/ncd-red-comm). It keeps
the parts of that library used for wireless communication and drops the rest: there is no Node-RED
node here and no I2C support. `ncd-red-comm` remains published, unchanged, for existing installs.

## Exports

| Export | What it is |
|---|---|
| `NcdSerial` | Transport over a serial port |
| `NcdTCP` | Transport over a TCP socket |
| `NcdDigiParser` | Builds and parses Digi XBee API frames over either transport |

```js
const comms = require('@ncd-io/wireless-comms');

const transport = new comms.NcdSerial('/dev/ttyUSB0', 115200);
const modem = new comms.NcdDigiParser(transport);

transport.on('ready', () => {
	modem.send.at_command('SL').then((res) => console.log(res.data));
});
transport.setupSerial();
```

The constructors do no I/O. Call `setupSerial()` on an `NcdSerial`, or `setupClient()` on an
`NcdTCP`, to open the link.

```js
new comms.NcdSerial(path, baudRate);
new comms.NcdTCP(host, port, crypto, inactivityTimeoutSeconds); // crypto is unused; pass false
comms.NcdSerial.list(); // resolves with the serial ports on this machine
```

## Transports

Both transports behave the same way.

| Event | When |
|---|---|
| `ready` | the link is open |
| `data` | one event per received byte |
| `closed_comms` | the link dropped unexpectedly |

**The transport owns reconnection.** After an unexpected drop it retries until the link is back. TCP
retries every 5 seconds. Serial tries once at once, then every 5 seconds. A consumer does not need to
call anything to recover from a drop.

| Call | Effect |
|---|---|
| `write(bytes, cb)` | On an open link, sends the bytes and returns `true`. On a closed link nothing is queued: it returns `false` and `cb` is called with an error whose `code` is `ERR_NCD_NOT_CONNECTED` |
| `reconnect()` | Drops the link if it is up and reopens it after 5 seconds. If the link is already down, makes sure one retry is pending. Does not emit `closed_comms` |
| `close(cb)` | Stops: cancels any pending retry and closes the link, even one that is still opening. The link stays closed, and `reconnect()` does nothing, until `setupSerial()` or `setupClient()` is called again |
| `on(event, fn)`, `removeListener(event, fn)` | Attach and detach listeners |

`_available` is `true` while the link is open.

An `NcdTCP` built with an inactivity timeout closes and reopens the socket after that many seconds
without traffic. Pass `0` or `false` to turn it off.

## Digi parser

`NcdDigiParser` takes a transport. `send` builds frames and returns a promise for the modem's
response:

```js
modem.send.at_command('ID', [0x7f, 0xff]);
modem.send.remote_at_command(mac, 'NI');
modem.send.transmit_request(mac, payloadBytes, options);
modem.send.explicit_addressing_command(mac, source, destination, cluster, profile, payloadBytes, options);
```

A request rejects after 5 seconds without a response, or at once if the transport refuses the write.

Incoming frames are emitted by type (`receive_packet`, `transmit_status`, `modem_status` and so on),
and every frame is also emitted as `digi_frame`. A frame type the parser has no decoder for is
emitted as `unknown` with its raw bytes.

## Tests

```bash
npm test
```

The tests run on Node 20 or later and need no hardware: the serial transport is tested against a
stand-in for `serialport`, the TCP transport against loopback sockets.

## License

MIT
