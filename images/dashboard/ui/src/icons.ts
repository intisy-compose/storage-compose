const paths: Record<string, string> = {
  nodes: '<rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/><circle cx="7" cy="7" r=".9" fill="currentColor"/><circle cx="7" cy="17" r=".9" fill="currentColor"/>',
  folders: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  attention: '<path d="M12 3 2.5 20h19z"/><path d="M12 10v4"/><circle cx="12" cy="17" r=".9" fill="currentColor"/>',
  activity: '<path d="M3 12h4l3-7 4 14 3-7h4"/>',
  requests: '<path d="M4 12h12"/><path d="m12 7 5 5-5 5"/><path d="M20 4v16"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>',
  theme: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
};

export function icon(name: keyof typeof paths | string, className = "icon"): SVGSVGElement {
  const template = document.createElement("template");
  template.innerHTML = `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? ""}</svg>`;
  return template.content.firstElementChild as SVGSVGElement;
}
