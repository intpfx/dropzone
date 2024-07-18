import process from 'node:process'
import parser from 'npm:ua-parser-js'
import { uniqueNamesGenerator, animals, colors } from 'npm:unique-names-generator'

function onProcess() {
	process.on('SIGINT', () => {
		console.info("SIGINT Received, exiting...")
		process.exit(0)
	})
	process.on('SIGTERM', () => {
		console.info("SIGTERM Received, exiting...")
		process.exit(0)
	})
	process.on('uncaughtException', (error, origin) => {
		console.log('----- Uncaught exception -----')
		console.log(error)
		console.log('----- Exception origin -----')
		console.log(origin)
	})
	process.on('unhandledRejection', (reason, promise) => {
		console.log('----- Unhandled Rejection at -----')
		console.log(promise)
		console.log('----- Reason -----')
		console.log(reason)
	})
}
function hashCode(str) {
	let hash = 0, i, chr;
	for (i = 0; i < str.length; i++) {
		chr = str.charCodeAt(i);
		hash = ((hash << 5) - hash) + chr;
		hash |= 0; // Convert to 32bit integer
	}
	return hash;
}
function isLocalNetwork(ip) {
	const parts = ip.split('.').map(part => parseInt(part, 10));
	if (parts[0] === 10) { // 10.0.0.0 - 10.255.255.255
		return true;
	} else if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) { // 172.16.0.0 - 172.31.255.255
		return true;
	} else if (parts[0] === 192 && parts[1] === 168) { // 192.168.0.0 - 192.168.255.255
		return true;
	}
	return false;
}

class DropzoneServer {
	constructor() {
		onProcess();
		this._rooms = {};
		Deno.serve((request, info) => {
			const url = new URL(request.url);
			const path = url.pathname;
			if (path.includes('images')) {
				const headers = new Headers();
				headers.set("content-type", "image/png");
				const body = Deno.readFileSync('./public' + path);
				const response = new Response(body, { status: 200, headers });
				return response;
			} else if (path.includes('scripts')) {
				const headers = new Headers();
				headers.set("content-type", "text/javascript");
				const body = Deno.readTextFileSync('./public' + path);
				const response = new Response(body, { status: 200, headers });
				return response;
			} else if (path.includes('sounds')) {
				const headers = new Headers();
				headers.set("content-type", "audio/mpeg");
				const body = Deno.readFileSync('./public' + path);
				const response = new Response(body, { status: 200, headers });
				return response;
			} else {
				switch (path) {
					case '/': {
						const headers = new Headers();
						headers.set("content-type", "text/html");
						const body = Deno.readTextFileSync('./public/index.html');
						const response = new Response(body, { status: 200, headers });
						return response;
					}
					case '/manifest.json': {
						const headers = new Headers();
						headers.set("content-type", "application/json");
						const body = Deno.readTextFileSync('./public/manifest.json');
						const response = new Response(body, { status: 200, headers });
						return response;
					}
					case '/styles.css': {
						const headers = new Headers();
						headers.set("content-type", "text/css");
						const body = Deno.readTextFileSync('./public/styles.css');
						const response = new Response(body, { status: 200, headers });
						return response;
					}
					case '/service-worker.js': {
						const headers = new Headers();
						headers.set("content-type", "text/javascript");
						const body = Deno.readTextFileSync('./public/service-worker.js');
						const response = new Response(body, { status: 200, headers });
						return response;
					}
					default: {
						if (path.includes('server')) {
							const requestClone = request.clone();
							const { socket, response } = Deno.upgradeWebSocket(request);
							socket.peerId = Peer.uuid();
							socket.onopen = () => this._onConnection(new Peer(socket, requestClone, info));
							console.log('Dropzone is running...');
							return response;
						} else {
							const headers = new Headers();
							headers.set("content-type", "text/html");
							const body = "404 Not Found";
							const response = new Response(body, { status: 200, headers });
							return response;
						}
					}
				}
			}
		})
	}

	_onConnection(peer) {
		this._joinRoom(peer);
		peer.socket.onmessage = (event) => this._onMessage(peer, event.data);
		this._keepAlive(peer);

		// send displayName
		this._send(peer, {
			type: 'display-name',
			message: {
				displayName: peer.name.displayName,
				deviceName: peer.name.deviceName,
				roomID: peer.rid
			}
		});
	}

	_onMessage(sender, message) {
		// Try to parse message 
		try {
			message = JSON.parse(message);
		} catch (_event) {
			console.error('Invalid JSON', message);
			return;
		}

		switch (message.type) {
			case 'disconnect':
				this._leaveRoom(sender);
				break;
			case 'pong':
				sender.lastBeat = Date.now();
				break;
			case 'updateRID':
				this._changeRoom(sender, message.rid);
				break;
		}

		// relay message to recipient
		if (message.to && this._rooms[sender.ip]) {
			const recipientId = message.to; // TODO: sanitize
			const recipient = this._rooms[sender.ip][recipientId];
			delete message.to;
			// add sender id
			message.sender = sender.id;
			this._send(recipient, message);
			return;
		}
	}

	_joinRoom(peer) {
		// if room doesn't exist, create it
		if (!this._rooms[peer.rid]) {
			this._rooms[peer.rid] = {};
		}

		// notify all other peers
		for (const otherPeerId in this._rooms[peer.rid]) {
			const otherPeer = this._rooms[peer.rid][otherPeerId];
			this._send(otherPeer, {
				type: 'peer-joined',
				peer: peer.getInfo()
			});
		}

		// notify peer about the other peers
		const otherPeers = [];
		for (const otherPeerId in this._rooms[peer.rid]) {
			otherPeers.push(this._rooms[peer.rid][otherPeerId].getInfo());
		}

		this._send(peer, {
			type: 'peers',
			peers: otherPeers
		});

		// add peer to room
		this._rooms[peer.rid][peer.id] = peer;
	}

	_leaveRoom(peer, isChangeRoom = false) {
		if (!this._rooms[peer.rid] || !this._rooms[peer.rid][peer.id]) return;
		if (!isChangeRoom) {
			this._cancelKeepAlive(this._rooms[peer.rid][peer.id]);
			peer.socket.close();
		}

		// delete the peer
		delete this._rooms[peer.rid][peer.id];

		//if room is empty, delete the room
		if (!Object.keys(this._rooms[peer.rid]).length) {
			delete this._rooms[peer.rid];
		} else {
			// notify all other peers
			for (const otherPeerId in this._rooms[peer.rid]) {
				const otherPeer = this._rooms[peer.rid][otherPeerId];
				this._send(otherPeer, { type: 'peer-left', peerId: peer.id });
			}
		}
	}

	_changeRoom(peer, rid) {
		this._leaveRoom(peer, true);
		peer.rid = rid;
		this._joinRoom(peer);
	}

	_send(peer, message) {
		if (!peer) return;
		if (peer.socket.readyState !== peer.socket.OPEN) return;
		message = JSON.stringify(message);
		peer.socket.send(message, _error => '');
	}

	_keepAlive(peer) {
		this._cancelKeepAlive(peer);
		const timeout = 30000;
		if (!peer.lastBeat) {
			peer.lastBeat = Date.now();
		}
		if (Date.now() - peer.lastBeat > 2 * timeout) {
			this._leaveRoom(peer);
			return;
		}

		this._send(peer, { type: 'ping' });

		peer.timerId = setTimeout(() => this._keepAlive(peer), timeout);
	}

	_cancelKeepAlive(peer) {
		if (peer && peer.timerId) {
			clearTimeout(peer.timerId);
		}
	}
}
class Peer {

	constructor(socket, request, info) {
		// set socket
		this.socket = socket;

		// set remote ip
		this._setIP(request, info);

		// set peer id
		this._setPeerId(socket);
		// set room id
		this._setRoomID();
		// is WebRTC supported ?
		this.rtcSupported = request.url.indexOf('webrtc') > -1;
		// set name 
		this._setName(request);
		// for keepalive
		this.timerId = 0;
		this.lastBeat = Date.now();
	}

	_setIP(request, info) {
		if (request.headers['x-forwarded-for']) {
			this.ip = request.headers['x-forwarded-for'].split(/\s*,\s*/)[0];
		} else {
			this.ip = info.remoteAddr.hostname;
		}
		// IPv4 and IPv6 use different values to refer to localhost
		if (this.ip == '::1' || this.ip == '::ffff:127.0.0.1') {
			this.ip = '127.0.0.1';
		}
		// Check if the IP is from a local network
		if (isLocalNetwork(this.ip)) {
			this.ip = '127.0.0.1';
		}
	}

	_setPeerId(socket) {
		this.id = socket.peerId;
	}

	_setRoomID() {
		this.rid = this.ip;
	}

	toString() {
		return `<Peer id=${this.id} ip=${this.ip} rtcSupported=${this.rtcSupported}>`
	}

	_setName(req) {
		const ua = parser(req.headers['user-agent']);

		let deviceName = '';

		if (ua.os && ua.os.name) {
			deviceName = ua.os.name.replace('Mac OS', 'Mac') + ' ';
		}

		if (ua.device.model) {
			deviceName += ua.device.model;
		} else {
			deviceName += ua.browser.name;
		}

		if (!deviceName)
			deviceName = 'Unknown Device';

		const displayName = uniqueNamesGenerator({
			length: 2,
			separator: ' ',
			dictionaries: [colors, animals],
			style: 'capital',
			seed: hashCode(this.id)
		})

		this.name = {
			model: ua.device.model,
			os: ua.os.name,
			browser: ua.browser.name,
			type: ua.device.type,
			deviceName,
			displayName
		};
	}

	getInfo() {
		return {
			id: this.id,
			name: this.name,
			rtcSupported: this.rtcSupported
		}
	}

	static uuid() {
		let uuid = '',
			ii;
		for (ii = 0; ii < 32; ii += 1) {
			switch (ii) {
				case 8:
				case 20:
					uuid += '-';
					uuid += (Math.random() * 16 | 0).toString(16);
					break;
				case 12:
					uuid += '-';
					uuid += '4';
					break;
				case 16:
					uuid += '-';
					uuid += (Math.random() * 4 | 8).toString(16);
					break;
				default:
					uuid += (Math.random() * 16 | 0).toString(16);
			}
		}
		return uuid;
	};
}

new DropzoneServer();