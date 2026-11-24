import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const resultsDir = new URL('./results/', import.meta.url)
const svgPath = fileURLToPath(new URL('./last-benchmark.svg', resultsDir))
const pngPath = fileURLToPath(new URL('./last-benchmark.png', resultsDir))

if (!fs.existsSync(svgPath)) {
  console.error('❌ Файл ./results/last-benchmark.svg не найден.')
  process.exit(1)
}

const svgContent = fs.readFileSync(svgPath, 'utf8')
const widthMatch = svgContent.match(/<svg[^>]*\bwidth="(\d+)"/)
const heightMatch = svgContent.match(/<svg[^>]*\bheight="(\d+)"/)
const width = widthMatch ? Number(widthMatch.at(1)) : 920
const height = heightMatch ? Number(heightMatch.at(1)) : 755

let rendered = false

try {
  const { Resvg } = await import('@resvg/resvg-js')
  const resvg = new Resvg(svgContent, { fitTo: { mode: 'zoom', value: 2 } })
  fs.writeFileSync(pngPath, resvg.render().asPng())
  console.log('🖼️  PNG сгенерирован через @resvg/resvg-js (2x Retina): ./results/last-benchmark.png')
  rendered = true
} catch {}

if (!rendered) {
  try {
    execFileSync('rsvg-convert', ['-z', '2', svgPath, '-o', pngPath], { stdio: 'ignore' })
    console.log('🖼️  PNG сгенерирован через rsvg-convert (2x Retina): ./results/last-benchmark.png')
    rendered = true
  } catch {}
}

if (!rendered) {
  const browsers = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']
  for (const bin of browsers) {
    try {
      execFileSync(
        bin,
        [
          '--headless=old',
          '--disable-gpu',
          '--hide-scrollbars',
          '--default-background-color=0d1117',
          `--screenshot=${pngPath}`,
          `--window-size=${width},${height}`,
          '--force-device-scale-factor=2',
          `file://${svgPath}`,
        ],
        { stdio: 'ignore' }
      )
      console.log(`🖼️  PNG сгенерирован через ${bin} (2x Retina): ./results/last-benchmark.png`)
      rendered = true
      break
    } catch {}
  }
}

if (!rendered) {
  console.warn('⚠️  Не удалось сгенерировать PNG.')
  process.exit(1)
}
