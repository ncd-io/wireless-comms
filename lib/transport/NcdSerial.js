const events = require("events");
const { SerialPort } = require('serialport');
const readOptions = require("./options.js");

const OPTIONS = {
	// Milliseconds to wait between attempts to reopen the port, and before a reconnect() reopens it.
	reconnectMs: { default: 5000, type: 'number', positive: true }
};

module.exports = class NcdSerial{
	constructor(port, baudRate, options, ...extra){
		options = readOptions('NcdSerial', '(path, baudRate, options)', options, extra, OPTIONS);
		this.port = port;
		this.baudRate = baudRate;
		this._emitter = new events.EventEmitter();
		this.tout = null;
		this.serialReconnectTime = options.reconnectMs;
		this._available = false;
		this._closing = false;
	}
	// Drops the link if it is up and re-establishes it after serialReconnectTime. On a link that
	// is already down this only makes sure one retry is pending. After close() it does nothing:
	// the link stays closed until setupSerial() is called.
	reconnect(){
		if(this._closing) return;
		if(this._available){
			this._discard(this.serial);
			this._available = false;
		}
		this._schedule();
	}
	// Schedules one attempt to open the port, unless one is already pending.
	_schedule(){
		var obj = this;
		if(this.tout !== null) return;
		this.tout = setTimeout(function() {
			obj.tout = null;
			if(!obj._available && !obj._closing){
				obj.setupSerial();
			}
		}, this.serialReconnectTime);
	}
	// Closes a port object this transport is done with. It is marked first, so the handlers
	// setupSerial() attached to it ignore whatever it still emits. A port that is still opening
	// cannot be closed yet; its 'open' handler closes it when it sees the mark.
	_discard(serial, cb){
		if(serial){
			serial._ncdDiscarded = true;
			if(serial.isOpen){
				serial.close(() => {
					if(typeof cb == 'function') cb();
				});
				return;
			}
		}
		if(typeof cb == 'function') process.nextTick(cb);
	}
	setupSerial(){
		var obj = this;
		obj._closing = false;

		this._discard(this.serial);
		// Every handler below checks that this port object is still the one in use. One that has
		// been replaced or discarded can still emit, and must not be taken for the live link.
		var serial = this.serial = new SerialPort({
			path: this.port,
			baudRate: this.baudRate,
			autoOpen: false
		});
		function stale(){ return obj.serial !== serial || serial._ncdDiscarded === true; }

		this.serial.on('error', function(err) {
			console.log(err);
		});
		this.serial.on('open',function() {
			if(stale()){
				// close() or a replacement arrived while this port was still opening.
				serial.close(() => {});
				return;
			}
			obj._closing = false;
			obj._available = true;
			if (obj.tout) { clearTimeout(obj.tout); obj.tout = null; }
			obj._emitter.emit('ready');
		});
		this.serial.on('data',function(d) {
			if(stale()) return;
			for (var z=0; z<d.length; z++) {
				obj._emitter.emit('data',d[z]);
			}
		});
		this.serial.on('close', function(err){
			if(stale() || obj._closing) return;
			if(err){
				console.log(err);
				obj._available = false;
				obj._emitter.emit('closed_comms');
				// A listener may have called close() or setupSerial() itself; then leave it be.
				if(stale() || obj._closing) return;
				// An unexpected drop: try to reopen at once. If that fails, the open callback
				// below takes over and retries every serialReconnectTime.
				obj.setupSerial();
			}
		});
		this.serial.open((err) => {
			if(err){
				if(stale() || obj._closing) return;
				console.log(err);
				obj._schedule();
			}
		});
	}
	// The serial ports present on this machine, as serialport reports them. Resolves with an
	// array of {path, manufacturer, serialNumber, ...}.
	static list(){
		return SerialPort.list();
	}
	on(a,b){ this._emitter.on(a,b); }
	removeListener(a,b){ this._emitter.removeListener(a,b); }
	// Stops: cancels any pending retry and closes the port, whether it is open or still opening.
	// The link stays closed until setupSerial() is called. The callback, if given, is called once
	// the port is down.
	close(cb){
		this._closing = true;
		if(this.tout){
			clearTimeout(this.tout);
			this.tout = null;
		}
		this._discard(this.serial, cb);
		this._available = false;
	}
	// Nothing is queued: a write on a closed link fails at once. Returns false and, if a callback
	// was given, calls it on the next tick with an error whose code is ERR_NCD_NOT_CONNECTED.
	write(m,cb){
		if(!this._available){
			return notConnected('NcdSerial: the serial port is not open', cb);
		}
		this.serial.write(m, cb);
		return true;
	}
};
function notConnected(message, cb){
	var err = new Error(message);
	err.code = 'ERR_NCD_NOT_CONNECTED';
	if(typeof cb == 'function') process.nextTick(cb, err);
	return false;
}
