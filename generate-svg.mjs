import fs from 'node:fs'

const SVG_NS = ['http:/', '/www.w3.org', '/2000/svg'].join('')

const resultsDir = new URL('./results/', import.meta.url)
const jsonPath = new URL('./last-benchmark.json', resultsDir)

if (!fs.existsSync(jsonPath)) {
  console.error('❌ Файл ./results/last-benchmark.json не найден.')
  process.exit(1)
}

const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
const rows = data.results

const escapeXml = (str) =>
  String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

const width = 920
const headerHeight = 115
const rowHeight = 56
const footerHeight = 70
const height = headerHeight + rows.length * rowHeight + footerHeight

// Чем меньше суммарный след (Footprint + Net Tick Alloc), тем выше компактность (100% у лидера)
const bestScore = Number(rows.at(0)['Memory Score (B)'])
const barMaxWidth = 280
const barStartX = 395

const rowsSvg = rows
  .map((r, idx) => {
    const y = headerHeight + idx * rowHeight
    const isFirst = idx === 0
    const score = Number(r['Memory Score (B)'])
    const ratioNum = bestScore > 0 ? score / bestScore : 1
    const barWidth = Math.max(8, Math.round((bestScore / Math.max(score, 1)) * barMaxWidth))

    const rowBg = idx % 2 === 0 ? '#161b22' : '#0d1117'
    const barColor = isFirst ? '#10b981' : idx < 5 ? '#3b82f6' : '#64748b'
    const rankColor = isFirst ? '#10b981' : '#8b949e'
    const fontWeight = isFirst ? '700' : '500'

    const leakVal = Number(r['Leak (B/cycle)'])
    const leakColor = leakVal <= 1 ? '#8b949e' : leakVal <= 20 ? '#f59e0b' : '#f87171'

    const titleText = r.Version ? `${ r.Engine } ${ r.Version }` : r.Engine
    const subtitle = `Node: ${ r['Node (B)'] } B | Tick: ${ r['Tick Alloc (B)'] } B | Leak: `

    return [
      `  <g transform="translate(0, ${ y })">`,
      `    <rect x="20" y="2" width="${ width - 40 }" height="${ rowHeight - 6 }" rx="8" fill="${ rowBg }" />`,
      `    <text x="42" y="34" fill="${ rankColor }" font-family="monospace" font-size="15" font-weight="700">#${ escapeXml(r.Rank) }</text>`,
      `    <text x="80" y="27" fill="#f0f6fc" font-family="sans-serif" font-size="14" font-weight="${ fontWeight }">${ escapeXml(titleText) }</text>`,
      `    <text x="80" y="45" fill="#8b949e" font-family="monospace" font-size="11">${ escapeXml(subtitle) }<tspan fill="${ leakColor }">${ leakVal.toFixed(2) } B/cyc</tspan></text>`,
      `    <rect x="${ barStartX }" y="21" width="${ barMaxWidth }" height="12" rx="4" fill="#21262d" />`,
      `    <rect x="${ barStartX }" y="21" width="${ barWidth }" height="12" rx="4" fill="${ barColor }" />`,
      `    <text x="${ barStartX + barMaxWidth + 16 }" y="32" fill="#f0f6fc" font-family="monospace" font-size="13" font-weight="700">${ escapeXml(score.toFixed(1)) } B</text>`,
      `    <text x="${ width - 38 }" y="32" text-anchor="end" fill="${ rankColor }" font-family="monospace" font-size="13" font-weight="700">${ escapeXml(r.Ratio) }</text>`,
      `  </g>`,
    ].join('\n')
  })
  .join('\n')

const subtitleHeader = `Node.js ${ data.nodeVersion } (${ data.platform }) | ${ data.cpuModel } | Isolated V8 (--expose-gc)`
const footerLine1 = `Generated: ${ data.timestamp } | Score = 10-node graph footprint + 1 batch tick alloc (lower is better)`

const svgContent = [
  `<?xml version="1.0" encoding="UTF-8"?>`,
  `<svg xmlns="${ SVG_NS }" width="${ width }" height="${ height }" viewBox="0 0 ${ width } ${ height }">`,
  `  <rect width="100%" height="100%" rx="14" fill="#0d1117" stroke="#30363d" stroke-width="1.5" />`,
  `  <text x="32" y="44" fill="#f0f6fc" font-family="sans-serif" font-size="20" font-weight="700">Reactive Engines Memory Benchmark (Footprint, Churn &amp; Leaks)</text>`,
  `  <text x="32" y="68" fill="#8b949e" font-family="monospace" font-size="12">${ escapeXml(subtitleHeader) }</text>`,
  `  <text x="32" y="96" fill="#8b949e" font-family="monospace" font-size="11" font-weight="700">RANK  ENGINE &amp; METRICS</text>`,
  `  <text x="${ barStartX }" y="96" fill="#8b949e" font-family="monospace" font-size="11" font-weight="700">MEMORY EFFICIENCY (LOWER = BETTER)</text>`,
  `  <text x="${ width - 38 }" y="96" text-anchor="end" fill="#8b949e" font-family="monospace" font-size="11" font-weight="700">SCORE / RATIO</text>`,
  `  <line x1="20" y1="105" x2="${ width - 20 }" y2="105" stroke="#21262d" stroke-width="1" />`,
  rowsSvg,
  `  <text x="32" y="${ height - 36 }" fill="#6e7681" font-family="monospace" font-size="11">${ escapeXml(footerLine1) }</text>`,
  `  <text x="32" y="${ height - 18 }" fill="#6e7681" font-family="monospace" font-size="11">Dispose Leak: <tspan fill="#8b949e">≤1 B/cyc clean</tspan> | <tspan fill="#f59e0b">1–20 B/cyc minor</tspan> | <tspan fill="#f87171">&gt;20 B/cyc retained subscriptions</tspan></text>`,
  `</svg>`,
].join('\n')

fs.writeFileSync(new URL('./last-benchmark.svg', resultsDir), svgContent)
console.log('Диаграмма ./results/last-benchmark.svg успешно сгенерирована!')
