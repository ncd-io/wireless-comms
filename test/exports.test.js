'use strict';
require('./helpers/fake-serialport');
const test = require('node:test');
const assert = require('node:assert');

test('the package exports the two transports and the Digi parser, and nothing else', () => {
	const comms = require('../index.js');
	assert.deepStrictEqual(Object.keys(comms).sort(), ['NcdDigiParser', 'NcdSerial', 'NcdTCP']);
	for(const name of Object.keys(comms)) assert.strictEqual(typeof comms[name], 'function');
});

test('the constructors do no I/O', () => {
	const comms = require('../index.js');
	const FakeSerialPort = require('./helpers/fake-serialport');
	FakeSerialPort.reset();
	const serial = new comms.NcdSerial('/dev/null', 115200);
	const tcp = new comms.NcdTCP('127.0.0.1', 1, false, 0);
	assert.strictEqual(FakeSerialPort.instances.length, 0);
	assert.strictEqual(serial._available, false);
	assert.strictEqual(tcp._available, false);
	assert.strictEqual(tcp.client, undefined);
});
