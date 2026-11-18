import { DeferredTransport, Message } from 'capnp-es';
import { Message as RpcMessage } from 'capnp-es/capnp/rpc';

const MAX_MESSAGE = 256 * 1024;

export class WebSocketTransport extends DeferredTransport {
  constructor(private socket: WebSocket, private failed: (error: Error) => void) {
    super();
    socket.binaryType = 'arraybuffer';
    socket.onmessage = (event) => {
      try {
        if (!(event.data instanceof ArrayBuffer) || event.data.byteLength > MAX_MESSAGE || this.queue.length >= 32) {
          throw new Error('RPC receive limit exceeded');
        }
        // Parse here so malformed data fails the connection rather than being ignored.
        new Message(event.data, false).getRoot(RpcMessage);
        this.resolve(event.data);
      } catch (error) { this.failed(error instanceof Error ? error : new Error(String(error))); }
    };
    socket.onclose = () => this.failed(new Error('Connection closed'));
    socket.onerror = () => this.failed(new Error('WebSocket failed'));
  }

  sendMessage(message: RpcMessage): void {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) throw new Error('Connection closed');
    const copy = new Message();
    copy.setRoot(message);
    const bytes = copy.toArrayBuffer();
    if (bytes.byteLength > MAX_MESSAGE || this.socket.bufferedAmount + bytes.byteLength > MAX_MESSAGE * 2) {
      const error = new Error('RPC send limit exceeded');
      this.failed(error);
      throw error;
    }
    this.socket.send(bytes);
  }

  close(error = new Error('Connection closed')): void {
    if (this.closed) return;
    this.socket.onclose = null;
    this.socket.onerror = null;
    this.socket.onmessage = null;
    this.socket.close();
    super.close(error);
  }
}
