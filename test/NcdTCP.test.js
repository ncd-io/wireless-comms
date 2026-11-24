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

// The reconnect contract (RC-030 and the rulings in the rebuild plan).
test('reconnect() on an open link closes it and re-dials after the delay, without closed_comms', async (t) => {
	quiet(t);
	const { srv, tcp, events } = await connected(t);
	const again = srv.connection();
	tcp.reconnect();
	assert.strictEqual(tcp._available, false);
	await again;
	await next(tcp, 'ready');
	assert.deepStrictEqual(events, ['ready', 'ready']);
	assert.strictEqual(srv.sockets.length, 2);
});

test('reconnect() while a re-dial is pending does not stack another', async (t) => {
	quiet(t);
	const { srv, tcp } = await connected(t);
	const again = srv.connection();
	tcp.reconnect();
	tcp.reconnect();
	tcp.reconnect();
	await again;
	await next(tcp, 'ready');
	await wait(150);
	assert.strictEqual(srv.sockets.length, 2);
});

test('close() stops a dial that is still in flight', async (t) => {
	quiet(t);
	const srv = await server();
	t.after(() => srv.stop());
	const tcp = new NcdTCP('127.0.0.1', srv.port, false, 0);
	tcp.tcpReconnectTime = 30;
	var readies = 0;
	tcp.on('ready', () => readies++);
	tcp.setupClient();
	tcp.close();
	await wait(150);
	assert.strictEqual(readies, 0, 'the connection was never announced');
	assert.strictEqual(tcp._available, false);
	assert.strictEqual(tcp.tout, null);
});

test('after close(), reconnect() does nothing until setupClient() is called', async (t) => {
	quiet(t);
	const { srv, tcp } = await connected(t);
	tcp.close();
	tcp.reconnect();
	assert.strictEqual(tcp.tout, null, 'no re-dial scheduled');
	await wait(150);
	assert.strictEqual(srv.sockets.length, 1);
	assert.strictEqual(tcp._available, false);

	const again = srv.connection();
	const ready = next(tcp, 'ready');
	tcp.setupClient();
	await again;
	await ready;
	assert.strictEqual(tcp._available, true);
});

test('close() cancels the retry loop of a link that cannot connect', async (t) => {
	quiet(t);
	const srv = await server();
	const port = srv.port;
	await srv.stop(); // nothing listens on this port now
	const tcp = new NcdTCP('127.0.0.1', port, false, 0);
	tcp.tcpReconnectTime = 20;
	var drops = 0;
	tcp.on('closed_comms', () => drops++);
	tcp.setupClient();
	await wait(100);
	assert.ok(drops >= 2, 'it was retrying');
	tcp.close();
	const seen = drops;
	await wait(100);
	assert.strictEqual(drops, seen, 'and stopped');
	assert.strictEqual(tcp.tout, null);
});

test('the inactivity timeout closes and re-dials, without closed_comms', async (t) => {
	quiet(t);
	const srv = await server();
	t.after(() => srv.stop());
	const tcp = new NcdTCP('127.0.0.1', srv.port, false, 0.05);
	tcp.tcpReconnectTime = 30;
	t.after(() => tcp.close());
	const events = [];
	tcp.on('ready', () => events.push('ready'));
	tcp.on('closed_comms', () => events.push('closed_comms'));
	tcp.setupClient();
	await next(tcp, 'ready');
	await next(tcp, 'ready'); // 50 ms of silence, then 30 ms, then connected again
	assert.deepStrictEqual(events, ['ready', 'ready']);
	assert.ok(srv.sockets.length >= 2);
});

// RC-031: close(cb) never called its callback.
test('close(cb) calls back once the socket is down', async (t) => {
	quiet(t);
	const { tcp } = await connected(t);
	const client = tcp.client;
	await new Promise((resolve) => tcp.close(resolve));
	assert.strictEqual(client.destroyed, true);
});

test('close(cb) calls back on a transport that was never opened', async () => {
	const tcp = new NcdTCP('127.0.0.1', 1, false, 0);
	await new Promise((resolve) => tcp.close(resolve));
});

test('removeListener() detaches a listener added with on()', () => {
	const tcp = new NcdTCP('127.0.0.1', 1, false, 0);
	var calls = 0;
	const listener = () => calls++;
	tcp.on('data', listener);
	tcp._emitter.emit('data', 1);
	tcp.removeListener('data', listener);
	tcp._emitter.emit('data', 2);
	assert.strictEqual(calls, 1);
});
