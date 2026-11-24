'use strict';
const FakeSerialPort = require('./helpers/fake-serialport');
const test = require('node:test');
const assert = require('node:assert');
const NcdSerial = require('../lib/transport/NcdSerial.js');
const { next, tick, quiet } = require('./helpers/util');

test.beforeEach(() => FakeSerialPort.reset());

test('setupSerial() opens the port and announces ready', async () => {
	const serial = new NcdSerial('/dev/ttyFAKE', 115200);
	const ready = next(serial, 'ready');
	serial.setupSerial();
	await ready;
	assert.strictEqual(serial._available, true);
	assert.strictEqual(FakeSerialPort.last().path, '/dev/ttyFAKE');
	assert.strictEqual(FakeSerialPort.last().options.baudRate, 115200);
});

test('incoming data is emitted one byte at a time', async () => {
	const serial = new NcdSerial('/dev/ttyFAKE', 115200);
	const ready = next(serial, 'ready');
	serial.setupSerial();
	await ready;
	const seen = [];
	serial.on('data', (b) => seen.push(b));
	FakeSerialPort.last().simulateData([0x7e, 0x00, 0x04]);
	assert.deepStrictEqual(seen, [0x7e, 0x00, 0x04]);
});

test('a failed open is retried every 5 seconds until it succeeds', async (t) => {
	quiet(t);
	t.mock.timers.enable({ apis: ['setTimeout'] });
	FakeSerialPort.failOpen = true;
	const serial = new NcdSerial('/dev/ttyFAKE', 115200);
	serial.setupSerial();
	await tick();
	assert.strictEqual(FakeSerialPort.instances.length, 1);
	t.mock.timers.tick(4999);
	assert.strictEqual(FakeSerialPort.instances.length, 1, 'no retry before 5 s');
	t.mock.timers.tick(1);
	assert.strictEqual(FakeSerialPort.instances.length, 2, 'retried at 5 s');
	await tick();
	FakeSerialPort.failOpen = false;
	t.mock.timers.tick(5000);
	await tick();
	assert.strictEqual(serial._available, true);
	assert.strictEqual(FakeSerialPort.instances.length, 3);
});

// RC-004: a fired or cleared timer left in `tout` reads as "a retry is pending" when none is.
test('no retry handle is left behind once the port is open', async (t) => {
	quiet(t);
	t.mock.timers.enable({ apis: ['setTimeout'] });
	FakeSerialPort.failOpen = true;
	const serial = new NcdSerial('/dev/ttyFAKE', 115200);
	serial.setupSerial();
	await tick();
	assert.notStrictEqual(serial.tout, null, 'a retry is pending');
	FakeSerialPort.failOpen = false;
	t.mock.timers.tick(5000);
	await tick();
	assert.strictEqual(serial._available, true);
	assert.strictEqual(serial.tout, null);
});
