/* jshint esversion: 6 */

var VERBOSE_NETWORK = false;

class ClassUtils {

	static loadClasses(classDescriptors) {
		for(const d of classDescriptors) {
			const clz = {className: d.name, javaClassName: d.javaName};

			for(const m of d.instanceMethods) {
				switch(m.type) {
					case "getter":
					{
						clz[m.name] = function() {
							return this[m.field];
						};
						break;
					}
					case "setter":
					{
						clz[m.name] = function(value) {
							this[m.field] = value;
						};
						break;
					}
				}
			}

			const castFunction = function(obj, enumStrict = true) {
				if(obj == null) return null;
				if(typeof obj !== "object") return;

				if(enumStrict && d.isEnum) {
					if(!obj.jsEnumName) throw "Not an enum value";
					return window[d.name][obj.jsEnumName];
				}

				Object.setPrototypeOf(obj, clz);
				obj._class = clz.javaClassName;
				return obj;
			};

			window[d.name] = function() {
				castFunction(this);
			};
			window[d.name].prototype = clz;
			window[d.name].cast = castFunction;
			window[d.name].isInstance = function(obj) {
				return Object.getPrototypeOf(obj) === clz;
			};

			if(d.isEnum) {
				for(const k in d.enumValues) {
					let e = d.enumValues[k];

					for(let key in e) {
						e[key] = ClassUtils.deserialize(e[key]);
					}

					e.name = function() {
						return k;
					}

					window[d.name][k] = castFunction(e, false);
				}

				window[d.name].valueOf = function(name) {
					return d.enumValues[name];
				}
			}
		}
	}

	static deserialize(rawObject) {
		if(typeof rawObject != "object" || rawObject == null) return rawObject;

		for(let key in rawObject) {
			rawObject[key] = ClassUtils.deserialize(rawObject[key]);
		}
		return rawObject.jsClass == null ? rawObject : window[rawObject.jsClass].cast(rawObject);
	}

	static preSerialize(object) {
		if(typeof object != "object" || object == null) return object;
		if(object.jsEnumName != null) return object.jsEnumName;

		for(let key in object) {
			object[key] = ClassUtils.preSerialize(object[key]);
		}
		return object;
	}

}


class Packet {

	constructor(id, referrerID, success, data, errorMessage) {
		this.id = id;
		this.referrerID = referrerID;
		this.success = success;
		this.data = data;
		this.errorMessage = errorMessage;
	}

	getID() {
		return this.id;
	}

	getReferrerID() {
		return this.referrerID;
	}

	isSuccess() {
		return this.success;
	}

	getData() {
		return this.data;
	}

	getErrorMessage() {
		return this.errorMessage;
	}

	serialize() {
		return JSON.stringify(ClassUtils.preSerialize(this));
	}

	static deserialize(rawPacket) {
		return new Packet(rawPacket.id, rawPacket.referrerID, rawPacket.success, ClassUtils.deserialize(rawPacket.data), rawPacket.errorMessage);
	}

	static of(data) {
		return new Packet(Packet.randomID(), null, true, data, null);
	}

	static randomID() {
		return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
	}

}

class Network {
	
	static init(verbose = false) {
		Network.packetQueue = [];
		let init = false;
		return new Promise((resolve, reject) => {
			Network.webSocket = new WebSocket(window.location.protocol.replace("http", "ws") + "//" + window.location.hostname + "/sswss");

			Network.webSocket.onerror = function(event) {
				if(VERBOSE_NETWORK) console.log("WebSocket error", event);
				reject(event);
				return;
			}

			Network.webSocket.onclose = function(event) {
				if(VERBOSE_NETWORK) console.log("WebSocket close", event);

				if(!init) {
					Popup.ofTitleAndText("Connection failed", "Failed to connect to the server").addButton("Okay", () => resetPage()).show();
					return;
				}

				switch(event.code) {
					case 1000: // Normal closure
					{
						if(Popup.getCurrentPopup() != null) return;
						Popup.ofTitleAndText("Connection lost", "You got disconnected\nReason: " + (event.reason == "" ? "Unknown reason" : event.reason)).addButton("Okay", () => resetPage()).show();
						return;
					}
					case 1001: // Going away
					{
						if(Popup.getCurrentPopup() != null) return;
						Popup.ofTitleAndText("Connection lost", "You got disconnected\nReason: Server shutting down/Client disconnect").addButton("Okay", () => resetPage()).show();
						return;
					}
					case 1006: // Abnormal closure
					{
						Popup.ofTitleAndText("Connection lost", "You got disconnected\nReason: Abnormal closure").addButton("Okay", () => resetPage()).show();
						return;
					}
					case 1008: // Policy violation
					{
						Popup.ofTitleAndText("Connection lost", "You got disconnected\nReason: Client-side error: " + (event.reason == "" ? "Unknown cause" : event.reason)).addButton("Okay", () => resetPage()).show();
						return;
					}
					default:
					{
						Popup.ofTitleAndText("Connection lost", "You got disconnected\nReason: Unknown (Code: " + event.code + ")").addButton("Okay", () => resetPage()).show();
						return;
					}
				}
				// alert("Uh-oh, it looks like you got disconnected. Please try rejoining from the main page");
			}

			Network.webSocket.addEventListener("message", ev => {
				let pack = JSON.parse(ev.data);

				if(VERBOSE_NETWORK) console.log("Received raw", pack);

				if(!init) {
					ClassUtils.loadClasses(pack.classes);
					resolve();
					init = true;
					if(verbose) console.log("Network initialized!");
					return;
				}
				let packet = Packet.deserialize(pack);
				if(PacketDisconnect.isInstance(packet.getData())) {
					if(verbose) console.log("Got disconnect from server");
					Network.webSocket.close(1000, "Disconnect");
					return;
				}

				if(PacketServerKeepAlive.isInstance(packet.getData())) {
					if(verbose) console.log("Got KeepAlive");
					return;
				}
				
				for(let wpI in Network.packetQueue) {
					let wp = Network.packetQueue[wpI];
					if(packet.getReferrerID() == wp.packet.getID()) {
						wp.resolve(packet);
						Network.packetQueue.splice(wpI, 1);
						return;
					}
				}

				Network.listener(packet);
			});
		});
	}

	static sendPacket(packet) {
		if(VERBOSE_NETWORK) console.log("Queued packet", packet);
		return new Promise((resolve) => {
			Network.packetQueue.push({packet: packet, resolve: resolve});
			Network.webSocket.send(packet.serialize());
		});
	}

	static setPacketListener(listener) {
		Network.listener = listener;
	}

}