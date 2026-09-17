export const COLORS = ["#3ec5a8", "#f5a03c", "#6a6bf5", "#9b5cf6", "#3b82f6", "#f2622a", "#d9508a"];

export function blobSvg(color, gid) {
  return `<svg viewBox="0 0 64 64" aria-hidden="true" style="--face-color:${color}">
    <defs>
      <radialGradient id="${gid}" cx="34%" cy="28%" r="72%">
        <stop class="hi" offset="0%"/>
        <stop class="mid" offset="46%"/>
        <stop class="lo" offset="100%"/>
      </radialGradient>
    </defs>
    <path class="blob" fill="url(#${gid})" d="M33 7c12.4-1.6 24.2 7.4 25.6 19.4 1.6 13.2-7.2 27.2-20.2 30.4C24.8 60 9.6 52.6 7.2 38.2 4.8 24.2 19.2 8.8 33 7z"/>
    <ellipse class="eye" cx="24.5" cy="30" rx="6.2" ry="7.8"/>
    <ellipse class="eye" cx="40.2" cy="31.2" rx="5.4" ry="7.1"/>
  </svg>`;
}

export function colorFor(id) {
  let n = 0;
  for (let i = 0; i < id.length; i++) n = (n + id.charCodeAt(i) * (i + 1)) % COLORS.length;
  return COLORS[n];
}
