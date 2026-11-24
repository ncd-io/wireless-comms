'use strict';
const test = require('node:test');
const assert = require('node:assert');
const NcdTCP = require('../lib/transport/NcdTCP.js');
const { next, wait, server, quiet } = require('./helpers/util');

test('reconnect() waits 5 seconds before re-dialling', (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const tcp = new NcdTCP('127.0.0.1', 1, false, 0);
	var dials = 0;
	tcp.setupClient = () => { dials++; };

	assert.strictEqual(tcp.tcpReconnectTime, 5000);
	tcp.reconnect();
	t.mock.timers.tick(4999);
	assert.strictEqual(dials, 0, 'no dial before the delay has passed');
	t.mock.timers.tick(1);
	assert.strictEqual(dials, 1, 'one dial once it has');
});

// RC-004: a cleared timer left in `tout` makes every later reconnect() a silent no-op.
test('close() leaves no retry handle behind', (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const tcp = new NcdTCP('127.0.0.1', 1, false, 0);
	tcp.setupClient = () => {};
	tcp.reconnect();
	assert.notStrictEqual(tcp.tout, null, 'a re-dial is pending');
	tcp.close();
	assert.strictEqual(tcp.tout, null);
});

test('a connect that beats a pending re-dial leaves no retry handle behind', async (t) => {
	quiet(t);
	const srv = await server();
	t.after(() => srv.stop());
	const tcp = new NcdTCP('127.0.0.1', srv.port, false, 0);
	t.after(() => tcp.close());

	tcp.reconnect();
	assert.notStrictEqual(tcp.tout, null, 'a re-dial is pending');
	const ready = next(tcp, 'ready');
	tcp.setupClient();
	await ready;
	assert.strictEqual(tcp.tout, null);
});

// RC-002 and the write-on-closed-link ruling: nothing is queued and no reconnect is triggered.
test('write() on a closed socket fails at once, queues nothing and dials nothing', async (t) => {
	const srv = await server();
	t.after(() => srv.stop());
	const tcp = new NcdTCP('127.0.0.1', srv.port, false, 0);
	t.after(() => tcp.close());
	const listeners = tcp._emitter.listenerCount('ready');

	var error;
	const returned = tcp.write([1, 2, 3], (err) => { error = err; });
	assert.strictEqual(returned, false);
	assert.strictEqual(error, undefined, 'the callback is not called synchronously');
	await wait(5);
	assert.ok(error instanceof Error);
	assert.strictEqual(error.code, 'ERR_NCD_NOT_CONNECTED');
	assert.strictEqual(tcp._emitter.listenerCount('ready'), listeners, 'no listener left behind');
	assert.strictEqual(tcp.tout, null, 'no re-dial was scheduled');
	assert.strictEqual(tcp.client, undefined, 'no socket was created');
	assert.strictEqual(tcp.write([4, 5, 6]), false, 'no callback is fine');

	const connection = srv.connection();
	const ready = next(tcp, 'ready');
	tcp.setupClient();
	const [socket] = await connection;
	await ready;
	const received = [];
	socket.on('data', (d) => received.push(...d));
	await wait(30);
	assert.deepStrictEqual(received, [], 'nothing was held back and sent on ready');
});

test('write() on a connected socket delivers the bytes', async (t) => {
	const srv = await server();
	t.after(() => srv.stop());
	const tcp = new NcdTCP('127.0.0.1', srv.port, false, 0);
	t.after(() => tcp.close());
	const connection = srv.connection();
	const ready = next(tcp, 'ready');
	tcp.setupClient();
	const [socket] = await connection;
	await ready;
	const data = next(socket, 'data');
	assert.strictEqual(tcp.write([0x7e, 0x00, 0x04]), true);
	const [chunk] = await data;
	assert.deepStrictEqual([...chunk], [0x7e, 0x00, 0x04]);
});
