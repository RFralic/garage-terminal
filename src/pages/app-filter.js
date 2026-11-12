// app-filter.js: the category buttons above /apps on the home page.
//
// Each app card in index.html has a category field:
//   <article class="app" data-category="garage">
// This script reads those, then builds  All · Garage · Gym  buttons with counts.
// A category only gets a button if at least one app uses it, so adding an app
// with a new category (e.g. data-category="other") adds an "Other" button
// automatically. Cards with no category count as "other".
// Without JavaScript, the buttons stay hidden and every app shows.

// Button order and labels. Categories not listed here come after these,
// alphabetically, labelled with a capital first letter.
const KNOWN = [
  ['garage', 'Garage'],
  ['gym', 'Gym'],
  ['home', 'Home'],
];

const list = document.getElementById('apps-list');
const bar = document.getElementById('apps-filter');
const countLabel = document.getElementById('apps-count');
const cards = [...list.querySelectorAll('.app')];
const categoryOf = (card) => (card.dataset.category || 'other').trim().toLowerCase();

// Which categories are in use, and how many apps each has.
const counts = new Map();
for (const card of cards) counts.set(categoryOf(card), (counts.get(categoryOf(card)) ?? 0) + 1);

const labelOf = (id) => KNOWN.find(([k]) => k === id)?.[1] ?? id.charAt(0).toUpperCase() + id.slice(1);
const order = [
  ...KNOWN.map(([id]) => id).filter((id) => counts.has(id)),
  ...[...counts.keys()].filter((id) => !KNOWN.some(([k]) => k === id)).sort(),
];

const plural = (n) => `${n} app${n === 1 ? '' : 's'}`;
countLabel.textContent = plural(cards.length);

function button(id, label, count) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip';
  b.dataset.category = id;
  b.append(label);
  const n = document.createElement('span');
  n.className = 'chip-count';
  n.textContent = String(count);
  b.append(n);
  b.addEventListener('click', () => select(id));
  return b;
}

function select(id) {
  for (const b of bar.querySelectorAll('.chip')) b.setAttribute('aria-pressed', String(b.dataset.category === id));
  for (const card of cards) card.hidden = id !== '' && categoryOf(card) !== id;
}

bar.replaceChildren(
  button('', 'All', cards.length),
  ...order.map((id) => button(id, labelOf(id), counts.get(id))),
);
bar.hidden = false;
select(''); // "All" by default
