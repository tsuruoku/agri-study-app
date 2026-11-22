// Minimal DOM construction helpers. Children are rendered via textContent /
// append only — never via innerHTML, so imported strings can't inject markup.

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "text") node.textContent = v;
    else if (k === "class") node.className = v;
    else if (k === "onclick") node.addEventListener("click", v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  appendKids(node, children);
  return node;
}

function appendKids(node, kids) {
  for (const c of [].concat(kids)) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) {
      appendKids(node, c);
      continue;
    }
    node.append(c);
  }
}

export const t = s => document.createTextNode(String(s));

export function card(children, cls = "card") {
  return el("section", { class: cls }, children);
}
