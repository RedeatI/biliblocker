/**
 * Open Shadow DOM helpers.
 *
 * Bilibili's 2026 comment UI is implemented as nested web components. Native
 * querySelector does not cross shadow boundaries, so page adapters and the
 * observer use these helpers to walk the composed tree without touching closed
 * roots.
 */

export type ComposedQueryRoot = Document | DocumentFragment | Element;

const NON_RENDERED_TEXT_ELEMENTS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT']);

/**
 * Read rendered text through open shadow roots and slots without executing page code.
 * Closed roots remain intentionally opaque.
 */
export function composedTextContent(root: Node): string {
  const parts: string[] = [];

  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent ?? '');
      return;
    }

    if (node instanceof Element) {
      if (NON_RENDERED_TEXT_ELEMENTS.has(node.tagName)) return;

      if (node instanceof HTMLSlotElement) {
        const assigned = node.assignedNodes({ flatten: true });
        const children = assigned.length > 0 ? assigned : [...node.childNodes];
        for (const child of children) walk(child);
        return;
      }

      if (node.shadowRoot) {
        walk(node.shadowRoot);
        return;
      }
    }

    for (const child of node.childNodes) walk(child);
  };

  walk(root);
  return parts.join('');
}

function childElements(root: ComposedQueryRoot): Element[] {
  if (root instanceof Element) return [root, ...root.querySelectorAll('*')];
  return [...root.querySelectorAll('*')];
}

/** Return every match in light DOM plus recursively reachable open shadow roots. */
export function querySelectorAllDeep<T extends Element = Element>(
  root: ComposedQueryRoot,
  selector: string,
): T[] {
  const out: T[] = [];
  const seenMatches = new Set<Element>();
  const seenRoots = new Set<ComposedQueryRoot>();

  const walk = (current: ComposedQueryRoot): void => {
    if (seenRoots.has(current)) return;
    seenRoots.add(current);

    if (current instanceof Element && current.matches(selector) && !seenMatches.has(current)) {
      seenMatches.add(current);
      out.push(current as T);
    }
    for (const match of current.querySelectorAll<T>(selector)) {
      if (seenMatches.has(match)) continue;
      seenMatches.add(match);
      out.push(match);
    }

    for (const element of childElements(current)) {
      if (element.shadowRoot) walk(element.shadowRoot);
    }
  };

  walk(root);
  return out;
}

/** Return the first match, respecting selector fallback order. */
export function firstSelectorDeep<T extends Element = Element>(
  root: ComposedQueryRoot,
  selectors: readonly string[],
): T | null {
  for (const selector of selectors) {
    const match = querySelectorAllDeep<T>(root, selector)[0];
    if (match) return match;
  }
  return null;
}

/** Find an ancestor across regular parent links and open shadow hosts. */
export function closestComposed<T extends Element = Element>(
  node: Element,
  selector: string,
): T | null {
  let current: Element | null = node;
  while (current) {
    if (current.matches(selector)) return current as T;
    if (current.parentElement) {
      current = current.parentElement;
      continue;
    }
    const root = current.getRootNode();
    current = root instanceof ShadowRoot ? root.host : null;
  }
  return null;
}

/** Visit every currently reachable open shadow root exactly once. */
export function openShadowRootsWithin(root: ComposedQueryRoot): ShadowRoot[] {
  const out: ShadowRoot[] = [];
  const seen = new Set<ShadowRoot>();

  const walk = (current: ComposedQueryRoot): void => {
    for (const element of childElements(current)) {
      const shadow = element.shadowRoot;
      if (!shadow || seen.has(shadow)) continue;
      seen.add(shadow);
      out.push(shadow);
      walk(shadow);
    }
  };

  walk(root);
  return out;
}
