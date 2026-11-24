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

// Opens a transport against a loopback server with a short reconnect delay. Returns the pieces.
async function connected(t, delay = 30){
	const srv = await server();
	t.after(() => srv.stop());
	const tcp = new NcdTCP('127.0.0.1', srv.port, false, 0);
	tcp.tcpReconnectTime = delay;
	t.after(() => tcp.close());
	const events = [];
	tcp.on('ready', () => events.push('ready'));
	tcp.on('closed_comms', () => events.push('closed_comms'));
	const connection = srv.connection();
	const ready = next(tcp, 'ready');
	tcp.setupClient();
	const [socket] = await connection;
	await ready;
	return { srv, tcp, socket, events };
}

// RC-003: a close that carries no error was ignored, leaving _available true on a dead socket.
test('a clean close by the far end is a drop: closed_comms, then a re-dial', async (t) => {
	quiet(t);
	const { srv, tcp, socket, events } = await connected(t);
	const closed = next(tcp, 'closed_comms');
	const again = srv.connection();
	socket.end();
	await closed;
	assert.strictEqual(tcp._available, false);
	await again;
	await next(tcp, 'ready');
	assert.strictEqual(tcp._available, true);
	assert.deepStrictEqual(events, ['ready', 'closed_comms', 'ready']);
	assert.strictEqual(srv.sockets.length, 2);
});

test('a close that carries an error is still a drop', async (t) => {
	quiet(t);
	const { srv, tcp, socket } = await connected(t);
	const closed = next(tcp, 'closed_comms');
	const again = srv.connection();
	socket.resetAndDestroy();
	await closed;
	await again;
	await next(tcp, 'ready');
	assert.strictEqual(tcp._available, true);
});

test('the close of a socket that setupClient() replaced is not a drop', async (t) => {
	quiet(t);
	const { srv, tcp, events } = await connected(t);
	const again = srv.connection();
	const ready = next(tcp, 'ready');
	tcp.setupClient();
	await again;
	await ready;
	await wait(150); // five reconnect delays: a re-dial loop would show as more connections
	assert.strictEqual(srv.sockets.length, 2, 'one connection per setupClient() call');
	assert.deepStrictEqual(events, ['ready', 'ready']);
	assert.strictEqual(tcp._available, true);
});

test('close() is deliberate: no closed_comms and no re-dial', async (t) => {
	quiet(t);
	const { srv, tcp, events } = await connected(t);
	tcp.close();
	await wait(150);
	assert.strictEqual(tcp._available, false);
	assert.strictEqual(srv.sockets.length, 1);
	assert.deepStrictEqual(events, ['ready']);
});

// What Atrium does to point the link at another modem (radiolink.js apply, linkwatch.js redial).
test('destroying the socket from outside and calling reconnect() ends in one new connection', async (t) => {
	quiet(t);
	const { srv, tcp } = await connected(t);
	const again = srv.connection();
	tcp.client.destroy();
	tcp._available = false;
	if(tcp.tout){ clearTimeout(tcp.tout); tcp.tout = null; }
	tcp.reconnect();
	await again;
	await next(tcp, 'ready');
	await wait(150);
	assert.strictEqual(srv.sockets.length, 2);
	assert.strictEqual(tcp._available, true);
});
