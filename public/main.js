///<reference lib="dom" />

const $ = query => document.getElementById(query);
const $$ = query => document.body.querySelector(query);
const isURL = text => /^((https?:\/\/|www)[^\s]+)/g.test(text.toLowerCase());
globalThis.URL = globalThis.URL || globalThis.webkitURL;
globalThis.isRtcSupported = !!(globalThis.RTCPeerConnection || globalThis.mozRTCPeerConnection || globalThis.webkitRTCPeerConnection);
globalThis.isDownloadSupported = (typeof document.createElement('a').download !== 'undefined');
globalThis.isProductionEnvironment = !globalThis.location.host.startsWith('localhost');
globalThis.iOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !globalThis.MSStream;

class Events {
	static fire(type, detail) {
		globalThis.dispatchEvent(new CustomEvent(type, { detail: detail }));
	}

	static on(type, callback) {
		return globalThis.addEventListener(type, callback, false);
	}
}

class ServerConnection {

	constructor() {
		this._connect();
		Events.on('beforeunload', () => this._disconnect());
		Events.on('pagehide', () => this._disconnect());
		document.addEventListener('visibilitychange', () => this._onVisibilityChange());
	}

	_connect() {
		clearTimeout(this._reconnectTimer);
		if (this._isConnected() || this._isConnecting()) return;
		const ws = new WebSocket(this._endpoint());
		ws.binaryType = 'arraybuffer';
		ws.onopen = () => console.log('WS: server connected');
		ws.onmessage = e => this._onMessage(e.data);
		ws.onclose = () => this._onDisconnect();
		ws.onerror = e => console.error(e);
		this._socket = ws;
	}

	_onMessage(msg) {
		msg = JSON.parse(msg);
		console.log('WS:', msg);
		switch (msg.type) {
			case 'peers':
				Events.fire('peers', msg.peers);
				break;
			case 'peer-online':
				Events.fire('peer-online', msg.message);
				break;
			case 'peer-offline':
				Events.fire('peer-offline', msg.message);
				break;
			case 'peer-joined':
				Events.fire('peer-joined', msg.peer);
				break;
			case 'peer-left':
				Events.fire('peer-left', msg.peerId);
				break;
			case 'signal':
				Events.fire('signal', msg);
				break;
			case 'ping':
				this.send({ type: 'pong' });
				break;
			case 'display-name':
				Events.fire('display-name', msg);
				break;
			default:
				console.error('WS: unkown message type', msg);
		}
	}

	send(message) {
		if (!this._isConnected()) return;
		this._socket.send(JSON.stringify(message));
	}

	_endpoint() {
		// hack to detect if deployment or development environment
		const protocol = location.protocol.startsWith('https') ? 'wss' : 'ws';
		const webrtc = globalThis.isRtcSupported ? '/webrtc' : '/fallback';
		const url = protocol + '://' + location.host + location.pathname + 'server' + webrtc;
		return url;
	}

	_disconnect() {
		this.send({ type: 'disconnect' });
		this._socket.onclose = null;
		this._socket.close();
	}

	_onDisconnect() {
		console.log('WS: server disconnected');
		Events.fire('notify-user', '链接丢失. 5秒后重试...');
		clearTimeout(this._reconnectTimer);
		this._reconnectTimer = setTimeout(_ => this._connect(), 5000);
	}

	_onVisibilityChange() {
		if (document.hidden) return;
		this._connect();
	}

	_isConnected() {
		return this._socket && this._socket.readyState === this._socket.OPEN;
	}

	_isConnecting() {
		return this._socket && this._socket.readyState === this._socket.CONNECTING;
	}
}

class Peer {

	constructor(serverConnection, peerId) {
		this._server = serverConnection;
		this._peerId = peerId;
		this._filesQueue = [];
		this._busy = false;
	}

	sendJSON(message) {
		this._send(JSON.stringify(message));
	}

	sendFiles(files) {
		for (let i = 0; i < files.length; i++) {
			this._filesQueue.push(files[i]);
		}
		if (this._busy) return;
		this._dequeueFile();
	}

	_dequeueFile() {
		if (!this._filesQueue.length) return;
		this._busy = true;
		const file = this._filesQueue.shift();
		this._sendFile(file);
	}

	_sendFile(file) {
		this.sendJSON({
			type: 'header',
			name: file.name,
			mime: file.type,
			size: file.size
		});
		this._chunker = new FileChunker(file,
			chunk => this._send(chunk),
			offset => this._onPartitionEnd(offset));
		this._chunker.nextPartition();
	}

	_onPartitionEnd(offset) {
		this.sendJSON({ type: 'partition', offset: offset });
	}

	_onReceivedPartitionEnd(offset) {
		this.sendJSON({ type: 'partition-received', offset: offset });
	}

	_sendNextPartition() {
		if (!this._chunker || this._chunker.isFileEnd()) return;
		this._chunker.nextPartition();
	}

	_sendProgress(progress) {
		this.sendJSON({ type: 'progress', progress: progress });
	}

	_onMessage(message) {
		if (typeof message !== 'string') {
			this._onChunkReceived(message);
			return;
		}
		message = JSON.parse(message);
		console.log('RTC:', message);
		switch (message.type) {
			case 'header':
				this._onFileHeader(message);
				break;
			case 'partition':
				this._onReceivedPartitionEnd(message);
				break;
			case 'partition-received':
				this._sendNextPartition();
				break;
			case 'progress':
				this._onDownloadProgress(message.progress);
				break;
			case 'transfer-complete':
				this._onTransferCompleted();
				break;
			case 'text':
				this._onTextReceived(message);
				break;
		}
	}

	_onFileHeader(header) {
		this._lastProgress = 0;
		this._digester = new FileDigester({
			name: header.name,
			mime: header.mime,
			size: header.size
		}, file => this._onFileReceived(file));
	}

	_onChunkReceived(chunk) {
		if (!chunk.byteLength) return;

		this._digester.unchunk(chunk);
		const progress = this._digester.progress;
		this._onDownloadProgress(progress);

		// occasionally notify sender about our progress 
		if (progress - this._lastProgress < 0.01) return;
		this._lastProgress = progress;
		this._sendProgress(progress);
	}

	_onDownloadProgress(progress) {
		Events.fire('file-progress', { sender: this._peerId, progress: progress });
	}

	_onFileReceived(proxyFile) {
		Events.fire('file-received', proxyFile);
		this.sendJSON({ type: 'transfer-complete' });
	}

	_onTransferCompleted() {
		this._onDownloadProgress(1);
		this._reader = null;
		this._busy = false;
		this._dequeueFile();
		Events.fire('notify-user', '文件传输完成');
	}

	sendText(text) {
		const unescaped = btoa(unescape(encodeURIComponent(text)));
		this.sendJSON({ type: 'text', text: unescaped });
	}

	_onTextReceived(message) {
		const escaped = decodeURIComponent(escape(atob(message.text)));
		Events.fire('text-received', { text: escaped, sender: this._peerId });
	}
}

class RTCPeer extends Peer {

	constructor(serverConnection, peerId) {
		super(serverConnection, peerId);
		this.config = {
			'sdpSemantics': 'unified-plan',
			'iceServers': [{
				urls: 'stun:stun.l.google.com:19302'
			}]
		};
		if (!peerId) return; // we will listen for a caller
		this._connect(peerId, true);
	}

	_connect(peerId, isCaller) {
		if (!this._conn) this._openConnection(peerId, isCaller);

		if (isCaller) {
			this._openChannel();
		} else {
			this._conn.ondatachannel = e => this._onChannelOpened(e);
		}
	}

	_openConnection(peerId, isCaller) {
		this._isCaller = isCaller;
		this._peerId = peerId;
		this._conn = new RTCPeerConnection(this.config);
		this._conn.onicecandidate = e => this._onIceCandidate(e);
		this._conn.onconnectionstatechange = e => this._onConnectionStateChange(e);
		this._conn.oniceconnectionstatechange = e => this._onIceConnectionStateChange(e);
	}

	_openChannel() {
		const channel = this._conn.createDataChannel('data-channel', {
			ordered: true,
			reliable: true // Obsolete. See https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel/reliable
		});
		channel.binaryType = 'arraybuffer';
		channel.onopen = e => this._onChannelOpened(e);
		this._conn.createOffer().then(d => this._onDescription(d)).catch(e => this._onError(e));
	}

	_onDescription(description) {
		// description.sdp = description.sdp.replace('b=AS:30', 'b=AS:1638400');
		this._conn.setLocalDescription(description)
			.then(_ => this._sendSignal({ sdp: description }))
			.catch(e => this._onError(e));
	}

	_onIceCandidate(event) {
		if (!event.candidate) return;
		this._sendSignal({ ice: event.candidate });
	}

	onServerMessage(message) {
		if (!this._conn) this._connect(message.sender, false);

		if (message.sdp) {
			this._conn.setRemoteDescription(new RTCSessionDescription(message.sdp))
				.then(_ => {
					if (message.sdp.type === 'offer') {
						return this._conn.createAnswer()
							.then(d => this._onDescription(d));
					}
				})
				.catch(e => this._onError(e));
		} else if (message.ice) {
			this._conn.addIceCandidate(new RTCIceCandidate(message.ice));
		}
	}

	_onChannelOpened(event) {
		console.log('RTC: channel opened with', this._peerId);
		const channel = event.channel || event.target;
		channel.onmessage = e => this._onMessage(e.data);
		channel.onclose = () => this._onChannelClosed();
		this._channel = channel;
	}

	_onChannelClosed() {
		console.log('RTC: channel closed', this._peerId);
		if (!this.isCaller) return;
		this._connect(this._peerId, true); // reopen the channel
	}

	_onConnectionStateChange() {
		console.log('RTC: state changed:', this._conn.connectionState);
		switch (this._conn.connectionState) {
			case 'disconnected':
				this._onChannelClosed();
				break;
			case 'failed':
				this._conn = null;
				this._onChannelClosed();
				break;
		}
	}

	_onIceConnectionStateChange() {
		switch (this._conn.iceConnectionState) {
			case 'failed':
				console.error('ICE Gathering failed');
				break;
			default:
				console.log('ICE Gathering', this._conn.iceConnectionState);
		}
	}

	_onError(error) {
		console.error(error);
	}

	_send(message) {
		if (!this._channel) return this.refresh();
		this._channel.send(message);
	}

	_sendSignal(signal) {
		signal.type = 'signal';
		signal.to = this._peerId;
		this._server.send(signal);
	}

	refresh() {
		// check if channel is open. otherwise create one
		if (this._isConnected() || this._isConnecting()) return;
		this._connect(this._peerId, this._isCaller);
	}

	_isConnected() {
		return this._channel && this._channel.readyState === 'open';
	}

	_isConnecting() {
		return this._channel && this._channel.readyState === 'connecting';
	}
}

class WSPeer {
	_send(message) {
		message.to = this._peerId;
		this._server.send(message);
	}
}

class PeersManager {

	constructor(serverConnection) {
		this.peers = {};
		this._server = serverConnection;
		Events.on('signal', e => this._onMessage(e.detail));
		Events.on('peers', e => this._onPeers(e.detail));
		Events.on('files-selected', e => this._onFilesSelected(e.detail));
		Events.on('send-text', e => this._onSendText(e.detail));
		Events.on('peer-left', e => this._onPeerLeft(e.detail));
	}

	_onMessage(message) {
		if (!this.peers[message.sender]) {
			this.peers[message.sender] = new RTCPeer(this._server);
		}
		this.peers[message.sender].onServerMessage(message);
	}

	_onPeers(peers) {
		peers.forEach(peer => {
			if (this.peers[peer.id]) {
				this.peers[peer.id].refresh();
				return;
			}
			if (globalThis.isRtcSupported && peer.rtcSupported) {
				this.peers[peer.id] = new RTCPeer(this._server, peer.id);
			} else {
				this.peers[peer.id] = new WSPeer(this._server, peer.id);
			}
		})
	}

	sendTo(peerId, message) {
		this.peers[peerId].send(message);
	}

	_onFilesSelected(message) {
		this.peers[message.to].sendFiles(message.files);
	}

	_onSendText(message) {
		this.peers[message.to].sendText(message.text);
	}

	_onPeerLeft(peerId) {
		const peer = this.peers[peerId];
		delete this.peers[peerId];
		if (peer) {
			// 检查是否有_channel属性 且_channel.readyState不为closed
			if (peer._channel && peer._channel.readyState !== 'closed') {
				peer._channel.close();
			}
			// 检查是否有_conn属性 且_conn.connectionState不为closed
			if (peer._conn && peer._conn.connectionState !== 'closed') {
				peer._conn.close();
			}
		}
	}

	clearPeers() {
		for (const peer in this.peers) {
			if (peer._channel && peer._channel.readyState !== 'closed') {
				peer._channel.close();
			}
			if (peer._conn && peer._conn.connectionState !== 'closed') {
				peer._conn.close();
			}
		}
		this.peers = {};
	}

}

class FileChunker {

	constructor(file, onChunk, onPartitionEnd) {
		this._chunkSize = 64000; // 64 KB
		this._maxPartitionSize = 1e6; // 1 MB
		this._offset = 0;
		this._partitionSize = 0;
		this._file = file;
		this._onChunk = onChunk;
		this._onPartitionEnd = onPartitionEnd;
		this._reader = new FileReader();
		this._reader.addEventListener('load', e => this._onChunkRead(e.target.result));
	}

	nextPartition() {
		this._partitionSize = 0;
		this._readChunk();
	}

	_readChunk() {
		const chunk = this._file.slice(this._offset, this._offset + this._chunkSize);
		this._reader.readAsArrayBuffer(chunk);
	}

	_onChunkRead(chunk) {
		this._offset += chunk.byteLength;
		this._partitionSize += chunk.byteLength;
		this._onChunk(chunk);
		if (this._isPartitionEnd() || this.isFileEnd()) {
			this._onPartitionEnd(this._offset);
			return;
		}
		this._readChunk();
	}

	repeatPartition() {
		this._offset -= this._partitionSize;
		this._nextPartition();
	}

	_isPartitionEnd() {
		return this._partitionSize >= this._maxPartitionSize;
	}

	isFileEnd() {
		return this._offset >= this._file.size;
	}

	get progress() {
		return this._offset / this._file.size;
	}
}

class FileDigester {

	constructor(meta, callback) {
		this._buffer = [];
		this._bytesReceived = 0;
		this._size = meta.size;
		this._mime = meta.mime || 'application/octet-stream';
		this._name = meta.name;
		this._callback = callback;
	}

	unchunk(chunk) {
		this._buffer.push(chunk);
		this._bytesReceived += chunk.byteLength || chunk.size;
		const _totalChunks = this._buffer.length;
		this.progress = this._bytesReceived / this._size;
		if (isNaN(this.progress)) this.progress = 1

		if (this._bytesReceived < this._size) return;
		// we are done
		const blob = new Blob(this._buffer, { type: this._mime });
		this._callback({
			name: this._name,
			mime: this._mime,
			size: this._size,
			blob: blob
		});
	}

}

class PeersUI {

	constructor() {
		Events.on('peer-joined', e => this._onPeerJoined(e.detail));
		Events.on('peer-left', e => this._onPeerLeft(e.detail));
		Events.on('peers', e => this._onPeers(e.detail));
		Events.on('file-progress', e => this._onFileProgress(e.detail));
		Events.on('paste', e => this._onPaste(e));
	}

	_onPeerJoined(peer) {
		if ($(peer.id)) return; // peer already exists
		const peerUI = new PeerUI(peer);
		$$('x-peers').appendChild(peerUI.$el);
		setTimeout(() => globalThis.animateBackground(false), 1750); // Stop animation
	}

	_onPeers(peers) {
		this._clearPeers();
		peers.forEach(peer => this._onPeerJoined(peer));

		// 判断x-peers是否为空，如果为空则执行动画
		if ($$('x-peers').innerHTML === '') {
			globalThis.animateBackground(true);
		}
	}

	_onPeerLeft(peerId) {
		const $peer = $(peerId);
		if (!$peer) return;
		$peer.remove();
	}

	_onFileProgress(progress) {
		const peerId = progress.sender || progress.recipient;
		const $peer = $(peerId);
		if (!$peer) return;
		$peer.ui.setProgress(progress.progress);
	}

	_clearPeers() {
		$$('x-peers').innerHTML = '';
	}

	_onPaste(e) {
		const files = e.clipboardData.files || e.clipboardData.items
			.filter(i => i.type.indexOf('image') > -1)
			.map(i => i.getAsFile());
		const peers = document.querySelectorAll('x-peer');
		// send the pasted image content to the only peer if there is one
		// otherwise, select the peer somehow by notifying the client that
		// "image data has been pasted, click the client to which to send it"
		// not implemented
		if (files.length > 0 && peers.length === 1) {
			Events.fire('files-selected', {
				files: files,
				to: $$('x-peer').id
			});
		}
	}
}

class PeerUI {

	html() {
		return `
            <label class="column center" title="Click to send files or right click to send a text">
                <input type="file" multiple>
                <x-icon shadow="1">
                    <svg class="icon"><use xlink:href="#"/></svg>
                </x-icon>
                <div class="progress">
                  <div class="circle"></div>
                  <div class="circle right"></div>
                </div>
                <div class="name font-subheading"></div>
                <div class="device-name font-body2"></div>
                <div class="status font-body2"></div>
            </label>`
	}

	constructor(peer) {
		this._peer = peer;
		this._initDom();
		this._bindListeners(this.$el);
	}

	_initDom() {
		const el = document.createElement('x-peer');
		el.id = this._peer.id;
		el.innerHTML = this.html();
		el.ui = this;
		el.querySelector('svg use').setAttribute('xlink:href', this._icon());
		el.querySelector('.name').textContent = this._displayName();
		el.querySelector('.device-name').textContent = this._deviceName();
		this.$el = el;
		this.$progress = el.querySelector('.progress');
	}

	_bindListeners(el) {
		el.querySelector('input').addEventListener('change', e => this._onFilesSelected(e));
		el.addEventListener('drop', e => this._onDrop(e));
		el.addEventListener('dragend', e => this._onDragEnd(e));
		el.addEventListener('dragleave', e => this._onDragEnd(e));
		el.addEventListener('dragover', e => this._onDragOver(e));
		el.addEventListener('contextmenu', e => this._onRightClick(e));
		el.addEventListener('touchstart', e => this._onTouchStart(e));
		el.addEventListener('touchend', e => this._onTouchEnd(e));
		// prevent browser's default file drop behavior
		Events.on('dragover', e => e.preventDefault());
		Events.on('drop', e => e.preventDefault());
	}

	_displayName() {
		return this._peer.name.displayName;
	}

	_deviceName() {
		return this._peer.name.deviceName;
	}

	_icon() {
		const device = this._peer.name.device || this._peer.name;
		if (device.type === 'mobile') {
			return '#phone-iphone';
		}
		if (device.type === 'tablet') {
			return '#tablet-mac';
		}
		return '#desktop-mac';
	}

	_onFilesSelected(e) {
		const $input = e.target;
		const files = $input.files;
		Events.fire('files-selected', {
			files: files,
			to: this._peer.id
		});
		$input.value = null; // reset input
	}

	setProgress(progress) {
		if (progress > 0) {
			this.$el.setAttribute('transfer', '1');
		}
		if (progress > 0.5) {
			this.$progress.classList.add('over50');
		} else {
			this.$progress.classList.remove('over50');
		}
		const degrees = `rotate(${360 * progress}deg)`;
		this.$progress.style.setProperty('--progress', degrees);
		if (progress >= 1) {
			this.setProgress(0);
			this.$el.removeAttribute('transfer');
		}
	}

	_onDrop(e) {
		e.preventDefault();
		const files = e.dataTransfer.files;
		Events.fire('files-selected', {
			files: files,
			to: this._peer.id
		});
		this._onDragEnd();
	}

	_onDragOver() {
		this.$el.setAttribute('drop', 1);
	}

	_onDragEnd() {
		this.$el.removeAttribute('drop');
	}

	_onRightClick(e) {
		e.preventDefault();
		Events.fire('text-recipient', this._peer.id);
	}

	_onTouchStart() {
		this._touchStart = Date.now();
		this._touchTimer = setTimeout(_ => this._onTouchEnd(), 610);
	}

	_onTouchEnd(e) {
		if (Date.now() - this._touchStart < 500) {
			clearTimeout(this._touchTimer);
		} else { // this was a long tap
			if (e) e.preventDefault();
			Events.fire('text-recipient', this._peer.id);
		}
	}
}

class Dialog {
	constructor(id) {
		this.$el = $(id);
		this.$el.querySelectorAll('[close]').forEach(el => el.addEventListener('click', () => this.hide()))
		this.$autoFocus = this.$el.querySelector('[autofocus]');
	}

	show() {
		this.$el.setAttribute('show', 1);
		if (this.$autoFocus) this.$autoFocus.focus();
	}

	hide() {
		this.$el.removeAttribute('show');
		document.activeElement.blur();
		globalThis.blur();
	}
}

class ReceiveDialog extends Dialog {

	constructor() {
		super('receiveDialog');
		Events.on('file-received', e => {
			this._nextFile(e.detail);
			window.blop.play();
		});
		this._filesQueue = [];
	}

	_nextFile(nextFile) {
		if (nextFile) this._filesQueue.push(nextFile);
		if (this._busy) return;
		this._busy = true;
		const file = this._filesQueue.shift();
		this._displayFile(file);
	}

	_dequeueFile() {
		if (!this._filesQueue.length) { // nothing to do
			this._busy = false;
			return;
		}
		// dequeue next file
		setTimeout(_ => {
			this._busy = false;
			this._nextFile();
		}, 300);
	}

	_displayFile(file) {
		const $a = this.$el.querySelector('#download');
		const url = URL.createObjectURL(file.blob);
		$a.href = url;
		$a.download = file.name;

		if (this._autoDownload()) {
			$a.click()
			return
		}
		if (file.mime.split('/')[0] === 'image') {
			console.log('the file is image');
			this.$el.querySelector('.preview').style.visibility = 'inherit';
			this.$el.querySelector("#img-preview").src = url;
		}

		this.$el.querySelector('#fileName').textContent = file.name;
		this.$el.querySelector('#fileSize').textContent = this._formatFileSize(file.size);
		this.show();

		if (globalThis.isDownloadSupported) return;
		// fallback for iOS
		$a.target = '_blank';
		const reader = new FileReader();
		reader.onload = () => $a.href = reader.result;
		reader.readAsDataURL(file.blob);
	}

	_formatFileSize(bytes) {
		if (bytes >= 1e9) {
			return (Math.round(bytes / 1e8) / 10) + ' GB';
		} else if (bytes >= 1e6) {
			return (Math.round(bytes / 1e5) / 10) + ' MB';
		} else if (bytes > 1000) {
			return Math.round(bytes / 1000) + ' KB';
		} else {
			return bytes + ' Bytes';
		}
	}

	hide() {
		this.$el.querySelector('.preview').style.visibility = 'hidden';
		this.$el.querySelector("#img-preview").src = "";
		super.hide();
		this._dequeueFile();
	}


	_autoDownload() {
		return !this.$el.querySelector('#autoDownload').checked
	}
}

class SendTextDialog extends Dialog {
	constructor() {
		super('sendTextDialog');
		Events.on('text-recipient', e => this._onRecipient(e.detail))
		this.$text = this.$el.querySelector('#textInput');
		const button = this.$el.querySelector('form');
		button.addEventListener('submit', e => this._send(e));
	}

	_onRecipient(recipient) {
		this._recipient = recipient;
		this._handleShareTargetText();
		this.show();

		const range = document.createRange();
		const sel = globalThis.getSelection();

		range.selectNodeContents(this.$text);
		sel.removeAllRanges();
		sel.addRange(range);

	}

	_handleShareTargetText() {
		if (!globalThis.shareTargetText) return;
		this.$text.textContent = globalThis.shareTargetText;
		globalThis.shareTargetText = '';
	}

	_send(e) {
		e.preventDefault();
		Events.fire('send-text', {
			to: this._recipient,
			text: this.$text.innerText
		});
	}
}

class ReceiveTextDialog extends Dialog {
	constructor() {
		super('receiveTextDialog');
		Events.on('text-received', e => this._onText(e.detail))
		this.$text = this.$el.querySelector('#text');
		const $copy = this.$el.querySelector('#copy');
		$copy.addEventListener('click', _ => this._onCopy());
	}

	_onText(e) {
		this.$text.innerHTML = '';
		const text = e.text;
		if (isURL(text)) {
			const $a = document.createElement('a');
			$a.href = text;
			$a.target = '_blank';
			$a.textContent = text;
			this.$text.appendChild($a);
		} else {
			this.$text.textContent = text;
		}
		this.show();
		window.blop.play();
	}

	async _onCopy() {
		await navigator.clipboard.writeText(this.$text.textContent);
		Events.fire('notify-user', '已复制到剪贴板');
	}
}

class Toast extends Dialog {
	constructor() {
		super('toast');
		Events.on('notify-user', e => this._onNotfiy(e.detail));
	}

	_onNotfiy(message) {
		this.$el.innerHTML = message;
		this.show();
		setTimeout(_ => this.hide(), 3000);
	}
}

class Notifications {
	constructor() {
		// Check if the browser supports notifications
		if (!('Notification' in window)) return;

		// Check whether notification permissions have already been granted
		if (Notification.permission !== 'granted') {
			this.$button = $('notification');
			this.$button.removeAttribute('hidden');
			this.$button.addEventListener('click', () => this._requestPermission());
		}
		Events.on('text-received', e => this._messageNotification(e.detail.text));
		Events.on('file-received', e => this._downloadNotification(e.detail.name));
	}

	_requestPermission() {
		Notification.requestPermission(permission => {
			if (permission !== 'granted') {
				Events.fire('notify-user', `通知权限已被阻止,<br/>因为用户已经多次取消了权限提示。<br/>这可以在页面信息中重置,<br/>可以通过点击URL旁边的锁图标来访问。` || 'Error');
				return;
			}
			this._notify('Even more snappy sharing!');
			this.$button.setAttribute('hidden', 1);
		});
	}

	_notify(message, body, closeTimeout = 20000) {
		const config = {
			body: body,
			icon: '/images/logo_transparent_128x128.png',
		}
		let notification;
		try {
			notification = new Notification(message, config);
		} catch (_e) {
			// Android doesn't support "new Notification" if service worker is installed
			if (!serviceWorker || !serviceWorker.showNotification) return;
			notification = serviceWorker.showNotification(message, config);
		}

		// Notification is persistent on Android. We have to close it manually
		if (closeTimeout) {
			setTimeout(_ => notification.close(), closeTimeout);
		}

		return notification;
	}

	_messageNotification(message) {
		if (isURL(message)) {
			const notification = this._notify(message, 'Click to open link');
			this._bind(notification, () => globalThis.open(message, '_blank', null, true));
		} else {
			const notification = this._notify(message, 'Click to copy text');
			this._bind(notification, () => this._copyText(message, notification));
		}
	}

	_downloadNotification(message) {
		const notification = this._notify(message, 'Click to download');
		if (!globalThis.isDownloadSupported) return;
		this._bind(notification, () => this._download(notification));
	}

	_download(notification) {
		document.querySelector('x-dialog [download]').click();
		notification.close();
	}

	_copyText(message, notification) {
		notification.close();
		if (!navigator.clipboard.writeText(message)) return;
		this._notify('Copied text to clipboard');
	}

	_bind(notification, handler) {
		if (notification.then) {
			notification.then(() => serviceWorker.getNotifications().then(_notifications => {
				serviceWorker.addEventListener('notificationclick', handler);
			}));
		} else {
			notification.onclick = handler;
		}
	}
}

class NetworkStatusUI {

	constructor() {
		globalThis.addEventListener('offline', () => this._showOfflineMessage(), false);
		globalThis.addEventListener('online', () => this._showOnlineMessage(), false);
		if (!navigator.onLine) this._showOfflineMessage();
	}

	_showOfflineMessage() {
		Events.fire('notify-user', '您已离线');
	}

	_showOnlineMessage() {
		Events.fire('notify-user', '您已重新联机');
	}
}

class WebShareTargetUI {
	constructor() {
		const parsedUrl = new URL(globalThis.location);
		const title = parsedUrl.searchParams.get('title');
		const text = parsedUrl.searchParams.get('text');
		const url = parsedUrl.searchParams.get('url');

		let shareTargetText = title ? title : '';
		shareTargetText += text ? shareTargetText ? ' ' + text : text : '';

		if (url) shareTargetText = url; // We share only the Link - no text. Because link-only text becomes clickable.

		if (!shareTargetText) return;
		globalThis.shareTargetText = shareTargetText;
		history.pushState({}, 'URL Rewrite', '/');
		console.log('Shared Target Text:', '"' + shareTargetText + '"');
	}
}

class Dropzone {
	constructor() {
		this.server = new ServerConnection();
		this.peers = new PeersManager(this.server);
		new PeersUI();
		Events.on('load', () => {
			new ReceiveDialog();
			new SendTextDialog();
			new ReceiveTextDialog();
			new Toast();
			new Notifications();
			new NetworkStatusUI();
			new WebShareTargetUI();
		});
	}
}

// set display name
Events.on('display-name', e => {
	const me = e.detail.message;
	const $displayName = $('displayName');
	$displayName.textContent = me.displayName;
	$displayName.title = me.deviceName;

	const $tip = $('tip');
	$tip.setAttribute('placeholder', me.serverRegion);
	const $roomID = $('roomID');
	$roomID.textContent = me.roomID;
	$roomID.addEventListener('focus', () => {
		$roomID.contentEditable = true;
		$tip.textContent = '点击此处以应用更改';
	});
	$roomID.addEventListener('blur', () => {
		$roomID.contentEditable = false;
		dropzone.server.send({ type: 'updateRID', rid: $roomID.textContent });
		dropzone.peers.clearPeers();
		$tip.textContent = '';
	});
});

// Background Animation
Events.on('load', () => {
	const c = document.createElement('canvas');
	document.body.appendChild(c);
	const style = c.style;
	style.width = '100%';
	style.position = 'absolute';
	style.zIndex = -1;
	style.top = 0;
	style.left = 0;
	const ctx = c.getContext('2d');
	let x0, y0, w, h, dw;

	function init() {
		w = globalThis.innerWidth;
		h = globalThis.innerHeight;
		c.width = w;
		c.height = h;
		let offset = h > 380 ? 100 : 65;
		offset = h > 800 ? 116 : offset;
		x0 = w / 2;
		y0 = h - offset;
		dw = Math.max(w, h, 1000) / 13;
		drawCircles();
	}
	globalThis.onresize = init;

	function drawCircle(radius) {
		ctx.beginPath();
		const color = Math.round(255 * (1 - radius / Math.max(w, h)));
		ctx.strokeStyle = 'rgba(' + color + ',' + color + ',' + color + ',0.1)';
		ctx.arc(x0, y0, radius, 0, 2 * Math.PI);
		ctx.stroke();
		ctx.lineWidth = 2;
	}

	let step = 0;

	function drawCircles() {
		ctx.clearRect(0, 0, w, h);
		for (let i = 0; i < 8; i++) {
			drawCircle(dw * i + step % dw);
		}
		step += 1;
	}

	let loading = true;

	function animate() {
		if (loading || step % dw < dw - 5) {
			requestAnimationFrame(function () {
				drawCircles();
				animate();
			});
		}
	}
	globalThis.animateBackground = function (l) {
		loading = l;
		animate();
	};
	init();
	animate();
});

Events.on('peer-online', e => {
	const ed = e.detail;
	Events.fire('notify-user', `${ed.displayName} 已在${ed.serverRegion}上线`);
});

Events.on('peer-offline', e => {
	const ed = e.detail;
	Events.fire('notify-user', `${ed.displayName} 已在${ed.serverRegion}下线`);
});

const dropzone = new Dropzone();

if ('serviceWorker' in navigator) {
	navigator.serviceWorker.register('/service-worker.js')
		.then(serviceWorker => {
			console.log('Service Worker registered');
			globalThis.serviceWorker = serviceWorker
		});
}

globalThis.addEventListener('beforeinstallprompt', e => {
	if (globalThis.matchMedia('(display-mode: standalone)').matches) {
		// don't display install banner when installed
		return e.preventDefault();
	} else {
		const btn = document.querySelector('#install')
		btn.hidden = false;
		btn.onclick = _ => e.prompt();
		return e.preventDefault();
	}
});

document.body.onclick = () => { // safari hack to fix audio
	document.body.onclick = null;
	if (!(/.*Version.*Safari.*/.test(navigator.userAgent))) return;
	blop.play();
}

(function () {
	// Select the button
	const btnTheme = document.getElementById('theme');
	// Check for dark mode preference at the OS level
	const prefersDarkScheme = globalThis.matchMedia('(prefers-color-scheme: dark)');
	// Get the user's theme preference from local storage, if it's available
	const currentTheme = localStorage.getItem('theme');
	// If the user's preference in localStorage is dark...
	if (currentTheme == 'dark') {
		// ...let's toggle the .dark-theme class on the body
		document.body.classList.toggle('dark-theme');
		// Otherwise, if the user's preference in localStorage is light...
	} else if (currentTheme == 'light') {
		// ...let's toggle the .light-theme class on the body
		document.body.classList.toggle('light-theme');
	}

	// Listen for a click on the button 
	btnTheme.addEventListener('click', function () {
		let theme;
		// If the user's OS setting is dark and matches our .dark-theme class...
		if (prefersDarkScheme.matches) {
			// ...then toggle the light mode class
			document.body.classList.toggle('light-theme');
			// ...but use .dark-theme if the .light-theme class is already on the body,
			theme = document.body.classList.contains('light-theme') ? 'light' : 'dark';
		} else {
			// Otherwise, let's do the same thing, but for .dark-theme
			document.body.classList.toggle('dark-theme');
			theme = document.body.classList.contains('dark-theme') ? 'dark' : 'light';
		}
		// Finally, let's save the current preference to localStorage to keep using it
		localStorage.setItem('theme', theme);
	});
})();

// Polyfill for Navigator.clipboard.writeText
if (!navigator.clipboard) {
	navigator.clipboard = {
		writeText: text => {

			// A <span> contains the text to copy
			const span = document.createElement('span');
			span.textContent = text;
			span.style.whiteSpace = 'pre'; // Preserve consecutive spaces and newlines

			// Paint the span outside the viewport
			span.style.position = 'absolute';
			span.style.left = '-9999px';
			span.style.top = '-9999px';

			const win = window;
			const selection = win.getSelection();
			win.document.body.appendChild(span);

			const range = win.document.createRange();
			selection.removeAllRanges();
			range.selectNode(span);
			selection.addRange(range);

			try {
				win.document.execCommand('copy');
			} catch (_err) {
				return Promise.error();
			}

			selection.removeAllRanges();
			span.remove();

			return Promise.resolve();
		}
	}
}