// Torque Chart: drawings of bolt heads seen from the top, showing each grade's marks.
// Returns an SVG string. "ABC" stands in for the maker's mark every brand adds.

const HEX = (() => {
  const pts = [];
  for (let i = 0; i < 6; i++) { const a = (Math.PI / 3) * i; pts.push(`${(50 + 44 * Math.cos(a)).toFixed(1)},${(50 + 44 * Math.sin(a)).toFixed(1)}`); }
  return pts.join(' ');
})();

function lines(n, start) {
  let out = '';
  for (let i = 0; i < n; i++) {
    const a = ((start + (360 / n) * i) * Math.PI) / 180;
    const x1 = 50 + 12 * Math.cos(a), y1 = 50 + 12 * Math.sin(a), x2 = 50 + 31 * Math.cos(a), y2 = 50 + 31 * Math.sin(a);
    out += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
  }
  return out;
}

export function headSvg(grade, px = 96, label = '') {
  let marks = '';
  if (grade === '5') marks = `<g stroke="var(--head-mark,#2b3540)" stroke-width="4" stroke-linecap="round">${lines(3, -90)}</g>`;
  else if (grade === '8') marks = `<g stroke="var(--head-mark,#2b3540)" stroke-width="4" stroke-linecap="round">${lines(6, -90)}</g>`;
  else if (grade !== '2') marks = `<text x="50" y="47" text-anchor="middle" font-family="IBM Plex Mono,ui-monospace,monospace" font-weight="700" font-size="${grade.length > 3 ? 17 : 19}" fill="var(--head-mark,#2b3540)">${grade}</text>`;
  const maker = `<text x="50" y="${grade.includes('.') ? 66 : 53}" text-anchor="middle" font-family="IBM Plex Sans Condensed,Arial,sans-serif" font-weight="600" font-size="${grade === '5' || grade === '8' ? 7.5 : grade.includes('.') ? 10 : 9}" fill="var(--head-mark,#2b3540)" opacity=".55">ABC</text>`;
  return `<svg class="head" viewBox="0 0 100 100" width="${px}" height="${px}" role="img" aria-label="${label || 'Bolt head'}">
    <polygon points="${HEX}" fill="var(--head-fill,#c9d1d8)" stroke="var(--head-edge,#7d8a95)" stroke-width="2.5" stroke-linejoin="round"/>
    <circle cx="50" cy="50" r="36" fill="none" stroke="var(--head-edge,#7d8a95)" stroke-width="1.2" opacity=".6"/>
    ${marks}${maker}</svg>`;
}
