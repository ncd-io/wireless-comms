'use strict';
const net = require('net');

// Resolves with the arguments of the next `event` on anything that has on(event, fn), or rejects
// after `ms`. The library's classes expose on() but not once(), so this does not detach.
function next(target, event, ms = 1000){
	return new Promise((resolve, reject) => {
		var done = false;
		var timer = setTimeout(() => {
			if(!done){ done = true; reject(new Error('timed out waiting for "' + event + '"')); }
		}, ms);
		target.on(event, (...args) => {
			if(done) return;
			done = true;
			clearTimeout(timer);
			resolve(args);
		});
	});
}

function wait(ms){
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Lets setImmediate callbacks queued by the fake serial port run.
function tick(){
	return new Promise((resolve) => setImmediate(resolve));
}

// A loopback TCP server that records its connections.
function server(){
	return new Promise((resolve) => {
		var sockets = [];
		var srv = net.createServer((socket) => {
			sockets.push(socket);
			socket.on('error', () => {});
		});
		srv.listen(0, '127.0.0.1', () => {
			resolve({
				port: srv.address().port,
				sockets: sockets,
				connection: () => next(srv, 'connection'),
				stop: () => new Promise((done) => {
					sockets.forEach((s) => s.destroy());
					srv.close(() => done());
				})
			});
		});
	});
}

// Silences console.log for the length of a test; the transports log every error.
function quiet(t){
	var log = console.log;
	console.log = () => {};
	t.after(() => { console.log = log; });
}

module.exports = { next, wait, tick, server, quiet };
