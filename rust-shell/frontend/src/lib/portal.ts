// Move shell-owned controls into the header without moving/remounting the app iframe.
export function portal(node: HTMLElement, target: HTMLElement) {
  target.append(node);
  return { destroy() { node.remove(); } };
}
