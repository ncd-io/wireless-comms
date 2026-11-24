'use strict';
const test = require('node:test');
const assert = require('node:assert');
const NcdDigiParser = require('../lib/protocol/NcdDigiParser.js');
const { fakeTransport, apiFrame } = require('./helpers/fake-transport');
const { quiet } = require('./helpers/util');

const MAC = [0x00, 0x13, 0xa2, 0x00, 0x41, 0x8c, 0x5f, 0x10];

function setup(){
	const transport = fakeTransport();
	const digi = new NcdDigiParser(transport);
	digi._timoutLimit = 50;
	const frames = [];
	digi.on('digi_frame', (f) => frames.push(f));
	return { transport, digi, frames };
}
// The request promises reject on timeout when no response is fed in; most tests only look at
// what was written.
function sent(promise){ promise.catch(() => {}); }

test('at_command builds an 0x08 frame and resolves with the matching response', async () => {
	const { transport, digi } = setup();
	const reply = digi.send.at_command('SL');
	assert.deepStrictEqual(transport.written[0], apiFrame(0x08, [1, 0x53, 0x4c]));
	transport.receive(apiFrame(0x88, [1, 0x53, 0x4c, 0, 0x41, 0x8c, 0x5f, 0x10]));
	const res = await reply;
	assert.strictEqual(res.type, 'at_command_response');
	assert.strictEqual(res.command, 'SL');
	assert.strictEqual(res.status, 'OK');
	assert.strictEqual(res.hasError, false);
	assert.deepStrictEqual(res.data, [0x41, 0x8c, 0x5f, 0x10]);
});

test('at_command with a parameter, and the queued form', () => {
	const { transport, digi } = setup();
	sent(digi.send.at_command('ID', [0x7f, 0xff]));
	sent(digi.send.at_command('ID', 5, true));
	assert.deepStrictEqual(transport.written[0], apiFrame(0x08, [1, 0x49, 0x44, 0x7f, 0xff]));
	assert.deepStrictEqual(transport.written[1], apiFrame(0x09, [2, 0x49, 0x44, 5]));
});

test('remote_at_command builds an 0x17 frame', () => {
	const { transport, digi } = setup();
	sent(digi.send.remote_at_command(MAC, 'NI', undefined, true));
	assert.deepStrictEqual(transport.written[0], apiFrame(0x17, [1, ...MAC, 0xff, 0xfe, 2, 0x4e, 0x49]));
});

test('a request with no response rejects after the timeout', async () => {
	const { digi } = setup();
	await assert.rejects(digi.send.at_command('SL'), (err) => {
		assert.strictEqual(err.error, 'Request timed out without response');
		return true;
	});
});

test('receive_packet carries the lower-cased MAC and the payload', () => {
	const { transport, frames } = setup();
	transport.receive(apiFrame(0x90, [...MAC, 0xff, 0xfe, 0xc1, 0x7f, 0x01, 0x02]));
	assert.strictEqual(frames.length, 1);
	assert.strictEqual(frames[0].type, 'receive_packet');
	assert.strictEqual(frames[0].mac, '00:13:a2:00:41:8c:5f:10');
	assert.deepStrictEqual(frames[0].data, [0x7f, 0x01, 0x02]);
});

test('a frame with a bad checksum is reported and not parsed', (t) => {
	quiet(t);
	const { transport, digi, frames } = setup();
	var errors = 0;
	digi.on('checksum_error', () => errors++);
	const bytes = apiFrame(0x90, [...MAC, 0xff, 0xfe, 0xc1, 0x7f]);
	bytes[bytes.length - 1] ^= 0xff;
	transport.receive(bytes);
	assert.strictEqual(errors, 1);
	assert.strictEqual(frames.length, 0);
});

test('bytes before a start delimiter are skipped', () => {
	const { transport, frames } = setup();
	transport.receive([0x00, 0x11, ...apiFrame(0x90, [...MAC, 0xff, 0xfe, 0xc1, 0x7f])]);
	assert.strictEqual(frames.length, 1);
});

// The three behavioural differences of the sensor library's fork (lib/DigiParser.js).
test('transmit_request builds an 0x10 frame from an array payload', () => {
	const { transport, digi } = setup();
	sent(digi.send.transmit_request(MAC, [0xf7, 0x01, 0x02]));
	assert.deepStrictEqual(transport.written[0],
		apiFrame(0x10, [1, ...MAC, 0xff, 0xfe, 0x00, 0xc0, 0xf7, 0x01, 0x02]));
});

test('transmit_request accepts a Buffer, a typed array or a single byte (ES-012)', () => {
	const { transport, digi } = setup();
	sent(digi.send.transmit_request(MAC, Buffer.from([0xf7, 0x01])));
	sent(digi.send.transmit_request(MAC, Uint8Array.from([0xf7, 0x01])));
	sent(digi.send.transmit_request(MAC, 0xf7));
	assert.deepStrictEqual(transport.written[0], apiFrame(0x10, [1, ...MAC, 0xff, 0xfe, 0x00, 0xc0, 0xf7, 0x01]));
	assert.deepStrictEqual(transport.written[1], apiFrame(0x10, [2, ...MAC, 0xff, 0xfe, 0x00, 0xc0, 0xf7, 0x01]));
	assert.deepStrictEqual(transport.written[2], apiFrame(0x10, [3, ...MAC, 0xff, 0xfe, 0x00, 0xc0, 0xf7]));
});

test('explicit_addressing_command builds a flat 0x11 frame (RC-009)', () => {
	const { transport, digi } = setup();
	sent(digi.send.explicit_addressing_command(MAC, 0xe8, 0xe8, [0x00, 0x14], [0xc1, 0x05], [0xaa]));
	assert.deepStrictEqual(transport.written[0],
		apiFrame(0x11, [1, ...MAC, 0xff, 0xfe, 0xe8, 0xe8, 0x00, 0x14, 0xc1, 0x05, 0x00, 0xc0, 0xaa]));
});

test('modem_status parses to an object with the status text and code (RC-006, ES-004)', () => {
	const { transport, frames } = setup();
	transport.receive(apiFrame(0x8a, [0x00]));
	transport.receive(apiFrame(0x8a, [0x0b]));
	assert.deepStrictEqual(frames[0], { status: 'Hardware reset', status_code: 0, type: 'modem_status' });
	assert.deepStrictEqual(frames[1], { status: 'Network woke up', status_code: 11, type: 'modem_status' });
});

test('modem_status with a status byte the parser has no text for does not throw', () => {
	const { transport, frames } = setup();
	transport.receive(apiFrame(0x8a, [0x02]));
	assert.deepStrictEqual(frames[0], { status: 'Unknown', status_code: 2, type: 'modem_status' });
});
