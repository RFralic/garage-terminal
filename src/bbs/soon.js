// soon.js: a placeholder for a BBS section that isn't open yet.
import { el } from '../lib/ui.js';

export function renderSoon(ctx, name) {
  ctx.main.replaceChildren(el('section', { class: 'b-sec' },
    el('h2', { class: 'sh' }, name),
    el('p', { class: 'soon' }, `${name} is still being built. Check back soon.`)));
}
