// Parsers for untrusted structured-clone messages. Origin/source checks remain
// with the frame or popup owner; parsing alone never authorizes a request.
export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
export type RpcId = string | number;
export function rpcId(value: unknown): value is RpcId {
  return typeof value === 'string' ? value.length <= 256 : typeof value === 'number' && Number.isFinite(value);
}
export function boundedJson(value: unknown, limit: number): boolean {
  try { const json = JSON.stringify(value); return typeof json === 'string' && json.length <= limit; }
  catch { return false; }
}
export function shareData(value: unknown): Record<string, string> | undefined {
  const data = record(value);
  if (!data || Object.keys(data).some(key => !['pathname', 'hash'].includes(key))) return;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x1f\x7f\\]/.test(value)) return;
    if (key === 'pathname' && (value.startsWith('//') || /(^|\/)(\.|%2e){2}(\/|$)/i.test(value))) return;
    result[key] = value;
  }
  return result;
}

export interface TemplateRequest {
  rpcId: string;
  template: string;
  petname?: string;
  roleAssignment?: unknown;
  forSharing?: boolean;
  clipboardButton?: 'left' | 'right' | null;
  style?: { color?: string };
  unauthenticated?: Record<string, unknown>;
  clientapp?: string;
}
export function templateRequest(value: unknown): TemplateRequest {
  const call = record(value);
  if (!call) throw new Error('Invalid template request.');
  const allowed = ['rpcId', 'template', 'petname', 'roleAssignment', 'forSharing', 'clipboardButton', 'style', 'unauthenticated', 'clientapp'];
  const unsupported = Object.keys(call).filter(key => !allowed.includes(key));
  if (unsupported.length) throw new Error(`Template option ${unsupported.join(', ')} requires the main shell.`);
  const style = record(call.style);
  if (typeof call.rpcId !== 'string' || !rpcId(call.rpcId) || typeof call.template !== 'string' || call.template.length > 32768 ||
      (call.petname !== undefined && (typeof call.petname !== 'string' || call.petname.length > 256)) ||
      (call.clientapp !== undefined && (typeof call.clientapp !== 'string' || !/^[a-zA-Z0-9+.-]{0,128}$/.test(call.clientapp))) ||
      (call.unauthenticated !== undefined && !record(call.unauthenticated)) ||
      (call.forSharing !== undefined && typeof call.forSharing !== 'boolean') ||
      ![undefined, null, 'left', 'right'].includes(call.clipboardButton as string | null | undefined) ||
      (call.style !== undefined && (!style || Object.keys(style).some(key => key !== 'color') ||
        (style.color !== undefined && (typeof style.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(style.color))))) ||
      !boundedJson(call, 65536)) throw new Error('Invalid template request.');
  return call as unknown as TemplateRequest;
}

export interface PowerboxRequest { rpcId: RpcId; query?: string[]; saveLabel?: Record<string, unknown> }
export function powerboxRequest(value: unknown): PowerboxRequest | undefined {
  const data = record(value);
  if (!data || !rpcId(data.rpcId) || !boundedJson(data, 65536)) return;
  if (data.query !== undefined && (!Array.isArray(data.query) || data.query.length > 32 ||
      data.query.some(q => typeof q !== 'string' || q.length > 8192))) return;
  if (data.saveLabel !== undefined && typeof record(data.saveLabel)?.defaultText !== 'string') return;
  return { rpcId: data.rpcId, query: data.query as string[] | undefined,
    saveLabel: record(data.saveLabel) };
}

// The app-facing title is the owner's title, never the recipient's alias.
export class GrainTitleSubscriptions {
  private subscriptions = new Set<RpcId>();
  private title: string;
  constructor(title: string, private reply: (result: { rpcId: RpcId; grainTitle: string }) => void) { this.title = title; }
  request(id: unknown, value: unknown, subscribe: unknown = false) {
    if (!rpcId(id) || !record(value) || typeof subscribe !== 'boolean') return;
    this.reply({ rpcId: id, grainTitle: this.title });
    if (subscribe && this.subscriptions.size < 32) this.subscriptions.add(id);
  }
  update(title: string) {
    if (title === this.title) return;
    this.title = title;
    for (const rpcId of this.subscriptions) this.reply({ rpcId, grainTitle: title });
  }
  clear() { this.subscriptions.clear(); }
}
