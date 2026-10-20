type Child = Node | string | null | undefined | false;

interface ElementOptions {
  className?: string;
  title?: string;
  attributes?: Record<string, string>;
  onClick?: (event: MouseEvent) => void;
}

export function element<Tag extends keyof HTMLElementTagNameMap>(
  tag: Tag,
  options: ElementOptions = {},
  ...children: Child[]
): HTMLElementTagNameMap[Tag] {
  const created = document.createElement(tag);
  if (options.className) created.className = options.className;
  if (options.title) created.title = options.title;
  for (const [name, value] of Object.entries(options.attributes ?? {})) created.setAttribute(name, value);
  const onClick = options.onClick;
  if (onClick) created.addEventListener("click", (event) => onClick(event as MouseEvent));
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    created.append(child);
  }
  return created;
}

export function text(tag: keyof HTMLElementTagNameMap, content: string, className?: string): HTMLElement {
  return element(tag, { className }, content);
}

export function button(label: string, onClick: () => void, className = "button"): HTMLButtonElement {
  const created = element("button", { className, attributes: { type: "button" } }, label);
  created.addEventListener("click", onClick);
  return created;
}

export function progressBar(fraction: number | null, tone: string, label: string): HTMLElement {
  const width = fraction === null ? 0 : Math.round(fraction * 1000) / 10;
  const fill = element("div", { className: `bar-fill tone-${tone}` });
  fill.style.width = `${width}%`;
  return element("div", { className: "bar", attributes: { role: "img", "aria-label": label } }, fill);
}

export function keyValueList(pairs: [string, Child | Child[]][]): HTMLElement {
  const list = element("dl", { className: "key-values" });
  for (const [key, value] of pairs) {
    const values = Array.isArray(value) ? value : [value];
    list.append(element("dt", {}, key), element("dd", {}, ...values));
  }
  return list;
}

export function section(heading: string, ...children: Child[]): HTMLElement {
  return element("section", { className: "detail-section" }, element("h3", {}, heading), ...children);
}
