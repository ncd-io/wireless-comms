const events = require("events");
const net = require("net");

module.exports = class NcdTCP{
	constructor(host, port, crypto, inactive_timeout = 900){
		// console.log('CONSTRUCTOR');
		this.port = port;
		this.host = host;
		this.inactive_timeout = inactive_timeout;
		this._emitter = new events.EventEmitter();
		this.crypto = typeof crypto == 'undefined' ? false : crypto;
		this.tout = null;
		this.tcpReconnectTime = 5000;
		this._available = false;
		this._closing = false;
	}

	setCrypto(crypto){
		this.crypto = crypto;
	}

	// Drops the link if it is up and re-establishes it after tcpReconnectTime. On a link that is
	// already down this only makes sure one re-dial is pending. After close() it does nothing: the
	// link stays closed until setupClient() is called.
	reconnect(){
		// console.log('RECONNECT');
		if(this._closing) return;
		if(this._available){
			this._discard(this.client);
			this._available = false;
		}
		this._schedule();
	}
	// Schedules one re-dial, unless one is already pending.
	_schedule(){
		var obj = this;
		if(this.tout !== null) return;
		// console.log('TOUT NULL');
		this.tout = setTimeout(function() {
			// console.log('TOUT FIRED');
			obj.tout = null;
			if(!obj._available && !obj._closing){
				obj.setupClient();
			}
		}, this.tcpReconnectTime);
	}
	// Destroys a socket this transport is done with. It is marked first, so the handlers
	// setupClient() attached to it ignore whatever it still emits.
	_discard(client){
		if(!client) return;
		client._ncdDiscarded = true;
		client.destroy();
	}
	setupClient(){
		// console.log('SETUPCLIENT');
		var obj = this;
		obj._closing = false;
		this._discard(this.client);
		// Every handler below checks that this socket is still the one in use. A socket that has
		// been replaced or discarded still emits 'close', and must not be taken for a drop.
		var client = this.client = new net.Socket();
		function stale(){ return obj.client !== client || client._ncdDiscarded === true; }
		this.client.removeAllListeners('error');
		this.client.removeAllListeners('connect');
		this.client.removeAllListeners('end');
		this.client.removeAllListeners('data');
		this.client.removeAllListeners('close');
		this.client.removeAllListeners('timeout');
		this.client.setNoDelay();

		this.client.on('error', (err) => {
			console.log(err);
		});
		this.client.on('connect', () => {
			if(stale()) return;
			obj._closing = false;
			obj._available = true;
			if(obj.tout){
				clearTimeout(obj.tout);
				obj.tout = null;
			}
			obj._emitter.emit('ready');
		});
		// this.client.on('timeout', function(err){
		// 	console.log(err);
		// });
		this.client.on('end', function(err){
			console.log(err);
		});
		this.client.on('data',function(d) {
			if(stale()) return;
			for (var z=0; z<d.length; z++) obj._emitter.emit('data',d[z]);
		});
		// Any close of the current socket that close() did not ask for is a drop, whether or not it
		// carried an error: a modem that closes its end cleanly is just as gone.
		this.client.on('close', function(){
			if(stale() || obj._closing) return;
			obj._available = false;
			obj._emitter.emit('closed_comms');
			obj._schedule();
		});
		this.buff = [];

		this.client.connect(this.port, this.host);
		this.client.setKeepAlive(true, 0);
		if(this.inactive_timeout){
			this.client.setTimeout(parseInt(this.inactive_timeout*1000));
			this.client.on('timeout', () => {
				if(stale()) return;
				console.log('SOCKET TIMED OUT ' + Date.now());
				obj.reconnect();
			});
		}

		// TODO forcing a write of empty byte improves reactivity on at least macOS, but still not extremely fast and the method doesn't make a lot of sense.
		// Look to implement in future after additional testing if required.
		// The tcp keepalive interval in nodejs is set via the OS layer interaction following library may allow for this, but may not be worth incompatiblilities
		// https://www.npmjs.com/package/net-keepalive
		// console.log(5000);
		// if(!Object.hasOwn(this, 'test_write')){
		// 	console.log('TESTWRITE INIT SECTION')
		// 	var that = this;
		// 	console.log('-=-=-=-=-=-=-=-=-=-=-');
		// 	console.log(that.inactive_timeout);
		// 	this.test_write = setInterval(function(){
		// 		if(!that._available){
		// 			console.log("not available -----------");
		// 			// clearInterval(that.test_write);
		// 			// delete that.test_write;
		// 			// that.reconnect();
		// 		}
		// 		else{
		// 			// that.write([254]);
		// 			that.write([0]);
		// 			// that.write([]);
		// 			console.log('I guess its available');
		// 		}
		// 	}, that.inactive_timeout);
		// }
		// this.checkState();
	}
	on(a,b){ this._emitter.on(a,b); }
	// Stops: cancels any pending re-dial and destroys the socket, whether it is connected or
	// still dialling. The link stays closed until setupClient() is called.
	close(cb){
		// console.log('CLOSE');
		this._closing = true;
		if(this.tout){
			clearTimeout(this.tout);
			this.tout = null;
		}
		this._discard(this.client);
		this._available = false;
	}
	// Nothing is queued and no reconnect is triggered: a write on a closed link fails at once.
	// Returns false and, if a callback was given, calls it on the next tick with an error whose
	// code is ERR_NCD_NOT_CONNECTED.
	write(m,cb){
		// console.log('WRITE');
		if(!this._available){
			return notConnected('NcdTCP: the socket is not connected', cb);
		}
		if(m.constructor == Array) m = Buffer.from(m);
		this.client.write(m, cb);
		return true;
	}
};
function notConnected(message, cb){
	var err = new Error(message);
	err.code = 'ERR_NCD_NOT_CONNECTED';
	if(typeof cb == 'function') process.nextTick(cb, err);
	return false;
}
