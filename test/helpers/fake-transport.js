'use strict';
const EventEmitter = require('events');

// The surface NcdDigiParser uses of a transport: on(), removeListener(), write(). `available`
// false makes write() fail the way the real transports do on a closed link.
function fakeTransport(){
	const emitter = new EventEmitter();
	const transport = {
		_emitter: emitter,
		available: true,
		written: [],
		on: (event, fn) => emitter.on(event, fn),
		removeListener: (event, fn) => emitter.removeListener(event, fn),
		write(packet, cb){
			if(!transport.available){
				var err = new Error('not connected');
				err.code = 'ERR_NCD_NOT_CONNECTED';
				if(cb) process.nextTick(cb, err);
				return false;
			}
			transport.written.push(Array.from(packet));
			if(cb) process.nextTick(cb, null);
			return true;
		},
		// Feeds bytes in one at a time, as the transports do.
		receive(bytes){ for(const b of bytes) emitter.emit('data', b); }
	};
	return transport;
}

// A complete Digi API frame: delimiter, length, type and data, checksum.
function apiFrame(type, data){
	const body = [type, ...data];
	const sum = body.reduce((t, n) => t + n, 0);
	return [0x7e, body.length >> 8, body.length & 255, ...body, 255 - (sum & 255)];
}

module.exports = { fakeTransport, apiFrame };
