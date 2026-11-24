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

## License

MIT
