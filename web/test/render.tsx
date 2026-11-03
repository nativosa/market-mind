import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect } from "vitest";
import type { App } from "../src/App";

// Rendering helpers for tests without a DOM: static HTML for what a user sees, and the expanded
// element tree for calling the handlers rendered elements carry.

export const html = (node: ReactElement) => renderToStaticMarkup(node);
export const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

export type Props = Record<string, unknown> & { children?: ReactNode };

/** Render function components (hook-free ones) down to host elements, keeping their props. */
export function expand(node: ReactNode): ReactNode {
  if (Array.isArray(node)) return node.map(expand);
  if (!isValidElement(node)) return node;
  const element = node as ReactElement<Props>;
  const type = element.type as unknown;
  if (typeof type === "function") return expand((type as (p: Props) => ReactNode)(element.props));
  if (typeof type === "object" && type !== null && "type" in type) return expand((type as { type: (p: Props) => ReactNode }).type(element.props));
  return { ...element, props: { ...element.props, children: expand(element.props.children) } };
}

export function findAll(node: ReactNode, match: (e: ReactElement<Props>) => boolean, out: ReactElement<Props>[] = []): ReactElement<Props>[] {
  if (Array.isArray(node)) node.forEach((n: ReactNode) => findAll(n, match, out));
  else if (isValidElement(node)) {
    const element = node as ReactElement<Props>;
    if (match(element)) out.push(element);
    findAll(element.props.children, match, out);
  }
  return out;
}

export const textOf = (node: ReactNode): string =>
  Array.isArray(node) ? node.map(textOf).join("") : isValidElement(node) ? textOf((node as ReactElement<Props>).props.children) : node === null || node === undefined || typeof node === "boolean" ? "" : String(node as string);
export const button = (tree: ReactNode, label: string) => {
  const found = findAll(tree, (e) => e.type === "button" && textOf(e.props.children).includes(label));
  expect(found, label).toHaveLength(1);
  return found[0]!.props as { onClick: () => void; disabled?: boolean };
};
export const call = (fn: unknown, ...args: unknown[]) => (fn as (...a: unknown[]) => void)(...args);

/** Render App once (hooks need a render) and return the element tree it produced, with its handlers. */
export function appTree(props: React.ComponentProps<typeof App>, renderApp: typeof App): ReactNode {
  let tree: ReactNode = null;
  function Probe() {
    tree = renderApp(props);
    return tree as ReactElement;
  }
  renderToStaticMarkup(<Probe />);
  return expand(tree);
}
