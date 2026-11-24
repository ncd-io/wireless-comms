'use strict';
// Reads the options object both transports take as their last constructor argument.
//
// `spec` maps each accepted key to a rule:
//   { default: <value>, type: 'number' }                 a finite number, 0 or more
//   { default: <value>, type: 'number', positive: true } a finite number above 0
//   { default: <value>, type: 'number', falseIsZero: true } as the first, and `false` reads as 0
//   { default: <value>, type: 'boolean' }
//
// Anything else is refused with a TypeError rather than ignored: a misspelt key or a call written
// for another signature would otherwise run with the default and nobody would know.
module.exports = function readOptions(className, signature, options, extra, spec){
	if(extra.length > 0 || (options !== undefined && (options === null || typeof options != 'object' || Array.isArray(options)))){
		throw new TypeError(className + ': expected ' + signature + ', where options is an object. ' +
			'Accepted options: ' + Object.keys(spec).join(', '));
	}
	options = options || {};
	for(var key of Object.keys(options)){
		if(!Object.prototype.hasOwnProperty.call(spec, key)){
			throw new TypeError(className + ': unknown option "' + key + '". ' +
				'Accepted options: ' + Object.keys(spec).join(', '));
		}
	}
	var out = {};
	for(var name of Object.keys(spec)){
		var rule = spec[name];
		var value = options[name];
		if(value === undefined){
			out[name] = rule.default;
			continue;
		}
		if(rule.type == 'boolean'){
			if(typeof value != 'boolean'){
				throw new TypeError(className + ': option "' + name + '" must be true or false');
			}
		}else{
			if(value === false && rule.falseIsZero) value = 0;
			var low = rule.positive ? value > 0 : value >= 0;
			if(typeof value != 'number' || !Number.isFinite(value) || !low){
				throw new TypeError(className + ': option "' + name + '" must be a number ' +
					(rule.positive ? 'above 0' : 'of 0 or more'));
			}
		}
		out[name] = value;
	}
	return out;
};
