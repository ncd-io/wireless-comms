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
