// app-filter.js: the controls above /apps on the home page:
//   - category buttons (All · Garage · Gym · …), below
//   - a ★ Favorites button and a star on every app card (below the categories)
//   - the Grid / List switch (at the end of this file)
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

// ---------- Favorites ------------------------------------------------------------
// Each card gets a star button. Starred apps show under the "★ Favorites" button.
// An app is identified by its Open link (e.g. "/apps/repclock"), so renaming an
// app keeps it starred. Saved in this browser only (like the Grid/List choice).

const FAV = '__fav';
const FAV_KEY = 'gt.apps.favorites';
const TAB_KEY = 'gt.apps.tab';
const appKey = (card) => card.querySelector('.meta a')?.getAttribute('href') || card.querySelector('h3')?.textContent.trim() || '';
const nameOf = (card) => card.querySelector('h3')?.textContent.trim() || 'this app';
let favs = new Set();
try { favs = new Set(JSON.parse(localStorage.getItem(FAV_KEY) || '[]').filter((k) => typeof k === 'string')); } catch { /* none saved */ }
const saveFavs = () => { try { localStorage.setItem(FAV_KEY, JSON.stringify([...favs])); } catch { /* storage blocked: works for this visit */ } };

const STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8z"/></svg>';
function paintStar(card) {
  const on = favs.has(appKey(card));
  const b = card.querySelector('.fav-btn');
  b.setAttribute('aria-pressed', String(on));
  b.setAttribute('aria-label', `${on ? 'Remove' : 'Add'} ${nameOf(card)} ${on ? 'from' : 'to'} favorites`);
  b.title = on ? 'Remove from favorites' : 'Add to favorites';
}
for (const card of cards) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'fav-btn';
  b.innerHTML = STAR;
  b.addEventListener('click', () => {
    const k = appKey(card);
    if (favs.has(k)) favs.delete(k); else favs.add(k);
    saveFavs();
    paintStar(card);
    favCount.textContent = String(favs.size);
    if (current === FAV) select(FAV); // un-starring on the Favorites tab hides the card
  });
  card.querySelector('.apphead').append(b);
  paintStar(card);
}

// Shown on the Favorites tab when nothing is starred yet.
const empty = document.createElement('p');
empty.className = 'fav-empty';
empty.hidden = true;
empty.innerHTML = 'No favorites yet. Tap the <span aria-hidden="true">☆</span> on any app to add it here.';
list.after(empty);

let current = '';
function select(id) {
  current = id;
  for (const b of bar.querySelectorAll('.chip')) b.setAttribute('aria-pressed', String(b.dataset.category === id));
  for (const card of cards) card.hidden = id === FAV ? !favs.has(appKey(card)) : id !== '' && categoryOf(card) !== id;
  empty.hidden = !(id === FAV && !cards.some((c) => favs.has(appKey(c))));
  try { localStorage.setItem(TAB_KEY, id); } catch { /* fine */ }
}

const favButton = button(FAV, '★ Favorites', favs.size);
favButton.classList.add('fav-chip');
const favCount = favButton.querySelector('.chip-count');
bar.replaceChildren(
  button('', 'All', cards.length),
  favButton,
  ...order.map((id) => button(id, labelOf(id), counts.get(id))),
);
bar.hidden = false;
// Open on the tab used last time (All the first time).
let startTab = '';
try { startTab = localStorage.getItem(TAB_KEY) || ''; } catch { /* All */ }
select(startTab === FAV || counts.has(startTab) ? startTab : '');

// ---------- Grid / List view ----------------------------------------------------
// Grid: the full cards. List: one compact row per app (icon, name, Open link),
// no description or screenshot; the styles for it are in home.css
// (.apps[data-view="list"]). The choice is remembered in this browser only.

const VIEW_KEY = 'gt.apps.view';
const viewSwitch = document.getElementById('apps-view');

function setView(v) {
  list.dataset.view = v;
  for (const b of viewSwitch.querySelectorAll('[data-view]')) b.setAttribute('aria-pressed', String(b.dataset.view === v));
  try { localStorage.setItem(VIEW_KEY, v); } catch { /* storage blocked: still works for this visit */ }
}

let savedView = 'grid';
try { if (localStorage.getItem(VIEW_KEY) === 'list') savedView = 'list'; } catch { /* use grid */ }
for (const b of viewSwitch.querySelectorAll('[data-view]')) b.addEventListener('click', () => setView(b.dataset.view));
setView(savedView);
viewSwitch.hidden = false;
