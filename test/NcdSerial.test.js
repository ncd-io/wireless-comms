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

// RC-002 and the write-on-closed-link ruling: nothing is queued for the next ready.
test('write() on a closed port fails at once and is never replayed', async () => {
	const serial = new NcdSerial('/dev/ttyFAKE', 115200);
	const listeners = serial._emitter.listenerCount('ready');

	var error;
	const returned = serial.write([1, 2, 3], (err) => { error = err; });
	assert.strictEqual(returned, false);
	assert.strictEqual(error, undefined, 'the callback is not called synchronously');
	await tick();
	assert.ok(error instanceof Error);
	assert.strictEqual(error.code, 'ERR_NCD_NOT_CONNECTED');
	assert.strictEqual(serial._emitter.listenerCount('ready'), listeners, 'no listener left behind');

	assert.strictEqual(serial.write([4, 5, 6]), false, 'no callback is fine');

	const ready = next(serial, 'ready');
	serial.setupSerial();
	await ready;
	await tick();
	assert.deepStrictEqual(FakeSerialPort.last().written, [], 'nothing was held back and sent on ready');
});

test('write() on an open port passes the bytes through', async () => {
	const serial = new NcdSerial('/dev/ttyFAKE', 115200);
	const ready = next(serial, 'ready');
	serial.setupSerial();
	await ready;
	var error = 'not called';
	assert.strictEqual(serial.write([1, 2, 3], (err) => { error = err; }), true);
	await tick();
	assert.strictEqual(error, null);
	assert.deepStrictEqual(FakeSerialPort.last().written, [[1, 2, 3]]);
});

// The reconnect contract (RC-030 and the rulings in the rebuild plan).
async function opened(){
	const serial = new NcdSerial('/dev/ttyFAKE', 115200);
	const events = [];
	serial.on('ready', () => events.push('ready'));
	serial.on('closed_comms', () => events.push('closed_comms'));
	const ready = next(serial, 'ready');
	serial.setupSerial();
	await ready;
	return { serial, events, port: FakeSerialPort.last() };
}

test('an unexpected drop announces closed_comms and reopens at once', async (t) => {
	quiet(t);
	const { serial, events, port } = await opened();
	port.simulateDrop();
	assert.strictEqual(serial._available, false);
	assert.strictEqual(FakeSerialPort.instances.length, 2, 'a new port object, with no delay');
	await tick();
	assert.strictEqual(serial._available, true);
	assert.deepStrictEqual(events, ['ready', 'closed_comms', 'ready']);
});

test('a drop whose device is gone retries every 5 seconds until it is back', async (t) => {
	quiet(t);
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const { serial, events, port } = await opened();
	FakeSerialPort.failOpen = true;
	port.simulateDrop();
	await tick();
	assert.strictEqual(FakeSerialPort.instances.length, 2);
	t.mock.timers.tick(5000);
	await tick();
	assert.strictEqual(FakeSerialPort.instances.length, 3);
	FakeSerialPort.failOpen = false;
	t.mock.timers.tick(5000);
	await tick();
	assert.strictEqual(serial._available, true);
	assert.deepStrictEqual(events, ['ready', 'closed_comms', 'ready']);
	assert.strictEqual(serial.tout, null);
});

test('reconnect() on an open port closes it and reopens after 5 seconds, without closed_comms', async (t) => {
	quiet(t);
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const { serial, events, port } = await opened();
	serial.reconnect();
	assert.strictEqual(serial._available, false);
	await tick();
	assert.strictEqual(port.isOpen, false, 'the port was closed');
	t.mock.timers.tick(4999);
	await tick();
	assert.strictEqual(FakeSerialPort.instances.length, 1, 'not reopened before 5 s');
	t.mock.timers.tick(1);
	await tick();
	assert.strictEqual(FakeSerialPort.instances.length, 2);
	assert.strictEqual(serial._available, true);
	assert.deepStrictEqual(events, ['ready', 'ready']);
});

test('reconnect() on a port that is already retrying opens no second port', async (t) => {
	quiet(t);
	t.mock.timers.enable({ apis: ['setTimeout'] });
	FakeSerialPort.failOpen = true;
	const serial = new NcdSerial('/dev/ttyFAKE', 115200);
	serial.setupSerial();
	await tick();
	serial.reconnect();
	serial.reconnect();
	await tick();
	assert.strictEqual(FakeSerialPort.instances.length, 1);
	t.mock.timers.tick(5000);
	await tick();
	assert.strictEqual(FakeSerialPort.instances.length, 2, 'one retry, on schedule');
});

test('close() cancels a pending retry', async (t) => {
	quiet(t);
	t.mock.timers.enable({ apis: ['setTimeout'] });
	FakeSerialPort.failOpen = true;
	const serial = new NcdSerial('/dev/ttyFAKE', 115200);
	serial.setupSerial();
	await tick();
	assert.notStrictEqual(serial.tout, null);
	serial.close();
	assert.strictEqual(serial.tout, null);
	FakeSerialPort.failOpen = false;
	t.mock.timers.tick(20000);
	await tick();
	assert.strictEqual(FakeSerialPort.instances.length, 1);
	assert.strictEqual(serial._available, false);
});

test('close() while the port is still opening leaves it closed and unannounced', async () => {
	const serial = new NcdSerial('/dev/ttyFAKE', 115200);
	var readies = 0;
	serial.on('ready', () => readies++);
	serial.setupSerial();
	serial.close();
	await tick();
	await tick();
	assert.strictEqual(readies, 0);
	assert.strictEqual(serial._available, false);
	assert.strictEqual(FakeSerialPort.last().isOpen, false);
});

test('after close(), reconnect() does nothing until setupSerial() is called', async (t) => {
	quiet(t);
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const { serial, port } = await opened();
	serial.close();
	await tick();
	assert.strictEqual(port.isOpen, false);
	serial.reconnect();
	assert.strictEqual(serial.tout, null, 'no retry scheduled');
	t.mock.timers.tick(20000);
	await tick();
	assert.strictEqual(FakeSerialPort.instances.length, 1);

	serial.setupSerial();
	await tick();
	assert.strictEqual(serial._available, true);
});

test('a port object that has been replaced is ignored', async (t) => {
	quiet(t);
	const { serial, events, port } = await opened();
	serial.setupSerial();
	await tick();
	const seen = [];
	serial.on('data', (b) => seen.push(b));
	port.simulateData([1, 2, 3]);
	port.simulateDrop();
	await tick();
	assert.deepStrictEqual(seen, []);
	assert.deepStrictEqual(events, ['ready', 'ready']);
	assert.strictEqual(FakeSerialPort.instances.length, 2);
	assert.strictEqual(serial._available, true);
});

// RC-031: close(cb) never called its callback.
test('close(cb) calls back once the port is down', async () => {
	const { serial, port } = await opened();
	await new Promise((resolve) => serial.close(resolve));
	assert.strictEqual(port.isOpen, false);
});

test('close(cb) calls back on a transport that was never opened', async () => {
	const serial = new NcdSerial('/dev/ttyFAKE', 115200);
	await new Promise((resolve) => serial.close(resolve));
});

test('removeListener() detaches a listener added with on()', () => {
	const serial = new NcdSerial('/dev/ttyFAKE', 115200);
	var calls = 0;
	const listener = () => calls++;
	serial.on('data', listener);
	serial._emitter.emit('data', 1);
	serial.removeListener('data', listener);
	serial._emitter.emit('data', 2);
	assert.strictEqual(calls, 1);
});

// serialport 10 and later: a named export, constructed from one options object.
test('the port is constructed the serialport 12 way, closed until opened', async () => {
	const { port } = await opened();
	assert.strictEqual(port.objectForm, true, 'one options object, not (path, options)');
	assert.strictEqual(port.path, '/dev/ttyFAKE');
	assert.strictEqual(port.options.baudRate, 115200);
	assert.strictEqual(port.options.autoOpen, false);
});

test('NcdSerial.list() resolves with the ports serialport reports', async () => {
	FakeSerialPort.ports = [{ path: '/dev/ttyUSB0', manufacturer: 'FTDI' }];
	assert.deepStrictEqual(await NcdSerial.list(), [{ path: '/dev/ttyUSB0', manufacturer: 'FTDI' }]);
});

// The options argument (plan addendum A-1).
test('with no options the reconnect time is 5 seconds', () => {
	assert.strictEqual(new NcdSerial('/dev/ttyFAKE', 115200).serialReconnectTime, 5000);
});

test('reconnectMs sets the delay reconnect() waits', (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const serial = new NcdSerial('/dev/ttyFAKE', 115200, { reconnectMs: 250 });
	assert.strictEqual(serial.serialReconnectTime, 250);
	var opens = 0;
	serial.setupSerial = () => { opens++; };
	serial.reconnect();
	t.mock.timers.tick(249);
	assert.strictEqual(opens, 0);
	t.mock.timers.tick(1);
	assert.strictEqual(opens, 1);
});

test('a bad options argument is refused', () => {
	assert.throws(() => new NcdSerial('/dev/ttyFAKE', 115200, 5000), TypeError);
	assert.throws(() => new NcdSerial('/dev/ttyFAKE', 115200, null), TypeError);
	assert.throws(() => new NcdSerial('/dev/ttyFAKE', 115200, {}, {}), TypeError);
	assert.throws(() => new NcdSerial('/dev/ttyFAKE', 115200, { reconnectMs: 0 }), TypeError);
	assert.throws(() => new NcdSerial('/dev/ttyFAKE', 115200, { inactivityTimeoutSec: 5 }), /inactivityTimeoutSec/);
});

// RC-035: the reopen that follows closed_comms undid a close() made by a listener.
test('close() from inside a closed_comms listener holds: no reopen, no retry', async (t) => {
	quiet(t);
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const { serial, events, port } = await opened();
	serial.on('closed_comms', () => serial.close());
	port.simulateDrop();
	await tick();
	assert.strictEqual(FakeSerialPort.instances.length, 1, 'no new port object');
	assert.strictEqual(serial.tout, null, 'no retry pending');
	t.mock.timers.tick(20000);
	await tick();
	assert.strictEqual(FakeSerialPort.instances.length, 1);
	assert.strictEqual(serial._available, false);
	assert.deepStrictEqual(events, ['ready', 'closed_comms']);
});

test('setupSerial() from inside a closed_comms listener opens one port, not two', async (t) => {
	quiet(t);
	const { serial, events, port } = await opened();
	serial.on('closed_comms', () => serial.setupSerial());
	port.simulateDrop();
	await tick();
	assert.strictEqual(FakeSerialPort.instances.length, 2);
	assert.strictEqual(serial._available, true);
	assert.deepStrictEqual(events, ['ready', 'closed_comms', 'ready']);
});
