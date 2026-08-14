import assert from 'node:assert/strict';
import { test } from 'node:test';
import { escapeHtml } from '../src/render/escape.js';
import { renderLayout } from '../src/render/templates/layout.js';
import { renderHomePage } from '../src/render/templates/home.js';

test('escapeHtml neutralizes HTML metacharacters', () => {
  const result = escapeHtml('<script>alert("x")</script> & \'quoted\'');
  assert.equal(result, '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quoted&#39;');
});

test('renderLayout escapes the title and embeds the body', () => {
  const html = renderLayout({ title: '<b>Hi</b>', bodyHtml: '<p>body</p>' });

  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<title>&lt;b&gt;Hi&lt;\/b&gt;<\/title>/);
  assert.match(html, /<p>body<\/p>/);
  assert.match(html, /<script type="module" src="\/js\/main\.js"><\/script>/);
});

test('renderHomePage produces a full HTML document with expected content', () => {
  const html = renderHomePage();

  assert.match(html, /<!doctype html>/);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /Request Service/);
  assert.match(html, /<link rel="stylesheet" href="\/css\/base\.css" \/>/);
});
