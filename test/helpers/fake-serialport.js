'use strict';
// A stand-in for the `serialport` module, installed before the library is loaded so the tests need
// no native binary. It answers both module shapes: serialport 9 (`require('serialport')` is the
// constructor, called as `new SerialPort(path, options)`) and serialport 10+ (`{ SerialPort }`,
// called as `new SerialPort({ path, ... })`).
const EventEmitter = require('events');
const Module = require('module');

class FakeSerialPort extends EventEmitter{
	constructor(path, options){
		super();
		this.objectForm = path !== null && typeof path == 'object';
		if(this.objectForm){
			options = path;
			path = options.path;
		}
		this.path = path;
		this.options = options || {};
		this.isOpen = false;
		this.written = [];
		FakeSerialPort.instances.push(this);
	}
	open(cb){
		setImmediate(() => {
			if(FakeSerialPort.failOpen){
				if(cb) cb(new Error('Error: No such file or directory, cannot open ' + this.path));
				return;
			}
			this.isOpen = true;
			this.emit('open');
			if(cb) cb(null);
		});
	}
	close(cb){
		if(!this.isOpen){
			var err = new Error('Port is not open');
			if(cb) setImmediate(cb, err);
			else setImmediate(() => this.emit('error', err));
			return;
		}
		this.isOpen = false;
		setImmediate(() => {
			this.emit('close');
			if(cb) cb(null);
		});
	}
	write(data, cb){
		this.written.push(data);
		if(cb) setImmediate(cb, null);
		return true;
	}
	// Test controls: what the real module does when the device goes away, and incoming bytes.
	simulateDrop(){
		this.isOpen = false;
		var err = new Error('Port disconnected');
		err.disconnected = true;
		this.emit('close', err);
	}
	simulateData(bytes){
		this.emit('data', Buffer.from(bytes));
	}
	static list(){
		return Promise.resolve(FakeSerialPort.ports);
	}
	static reset(){
		FakeSerialPort.instances = [];
		FakeSerialPort.failOpen = false;
		FakeSerialPort.ports = [];
	}
	static last(){
		return FakeSerialPort.instances[FakeSerialPort.instances.length - 1];
	}
}
FakeSerialPort.reset();
FakeSerialPort.SerialPort = FakeSerialPort;

const load = Module._load;
Module._load = function(request, ...rest){
	if(request === 'serialport') return FakeSerialPort;
	return load.call(this, request, ...rest);
};

module.exports = FakeSerialPort;
