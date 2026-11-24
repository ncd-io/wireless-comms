const events = require("events");
const sp = require('serialport');

module.exports = class NcdSerial{
	constructor(port, baudRate){
		this.port = port;
		this.baudRate = baudRate;
		this._emitter = new events.EventEmitter();
		this.tout = null;
		this.serialReconnectTime = 5000;
		this._available = false;
		this._closing = false;
	}
	reconnect(){
		var obj = this;
		if(this._available){
			this.close();
		}else{
			if(this._closing == false){
				this.setupSerial();
			}
		}
	}
	setupSerial(){
		var obj = this;
		obj._closing = false;

		this.serial = new sp(this.port, {
			baudRate: this.baudRate,
			autoOpen: false
		});

		this.serial.on('error', function(err) {
			console.log(err);
		});
		this.serial.on('open',function() {
			obj._closing = false;
			obj._available = true;
			if (obj.tout) { clearTimeout(obj.tout); obj.tout = null; }
			obj._emitter.emit('ready');
		});
		this.serial.on('data',function(d) {
			for (var z=0; z<d.length; z++) {
				obj._emitter.emit('data',d[z]);
			}
		});
		this.serial.on('close', function(err){
			if(err){
				console.log(err);
				obj._available = false;
				obj._emitter.emit('closed_comms');
				obj.reconnect();
			}
		});
		this.serial.open((err) => {
			if(err){
				console.log(err);
				obj.tout = setTimeout(function() {
					obj.tout = null;
					obj.setupSerial();
				}, obj.serialReconnectTime);
			}
		});
	}
	on(a,b){ this._emitter.on(a,b); }
	close(cb){
		this._closing = true;
		if(this._available){
			this.serial.close();
		}
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
