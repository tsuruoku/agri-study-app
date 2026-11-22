import { test } from "node:test";
import assert from "node:assert/strict";

class FakeEl {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this._text = "";
    this.className = "";
  }
  append(...kids) {
    for (const k of kids) this.children.push(k);
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  addEventListener(name, fn) {
    (this.listeners[name] ??= []).push(fn);
  }
  get textContent() {
    return this._text;
  }
  set textContent(v) {
    this._text = v;
    this.children = [];
  }
}

globalThis.document = {
  createElement: tag => new FakeEl(tag),
  createTextNode: s => ({ node: "#text", text: String(s) }),
};

const { el, card } = await import("../web/dom.js");

test("el flattens nested child arrays recursively", () => {
  const p1 = new FakeEl("p");
  const p2 = new FakeEl("p");
  const node = el("section", {}, [[p1, null], [p2, false], undefined]);
  assert.equal(node.children.length, 2);
  assert.equal(node.children[0], p1);
  assert.equal(node.children[1], p2);
});

test("el keeps hyphenated aria attributes literal", () => {
  const node = el("button", { "aria-label": "閉じる", "aria-pressed": true, role: "group" });
  assert.equal(node.attributes["aria-label"], "閉じる");
  assert.equal(node.attributes["aria-pressed"], "");
  assert.equal(node.attributes["role"], "group");
  assert.ok(!("aria--label" in node.attributes));
});

test("el uses textContent, never innerHTML-bearing strings", () => {
  const node = el("p", { text: "<img src=x>" });
  assert.equal(node._text, "<img src=x>");
  assert.equal(node.children.length, 0);
});

test("card returns a section with the given class", () => {
  const node = card([el("p")]);
  assert.equal(node.tagName, "section");
  assert.equal(node.className, "card");
});
