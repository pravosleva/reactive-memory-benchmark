import fs from 'node:fs'

const resultsDir = new URL('./results/', import.meta.url)
const jsonPath = new URL('./last-benchmark.json', resultsDir)
const readmePath = new URL('./README.md', import.meta.url)

if (!fs.existsSync(jsonPath)) {
  console.error('❌ Файл ./results/last-benchmark.json не найден.')
  process.exit(1)
}

const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
const rows = data.results

const tableHeader = [
  '| Rank | Engine | Node (B) | Tick Alloc (B) | Minor GC | GC Pause (ms) | Leak (B/cycle) | Memory Score (B) | Ratio |',
  '| :---: | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |',
].join('\n')

const tableRows = rows
  .map((r) => {
    const isFirst = r.Rank === 1
    const label = r.Version ? `${ r.Engine } \`${ r.Version }\`` : r.Engine
    const engineName = isFirst ? `**${ label }**` : label
    const nodeVal = r['Node (B)']
    const tickVal = r['Tick Alloc (B)']
    const minorGc = `${ r['Minor GC (count)'] ?? 0 }×`
    const gcPause = Number(r['GC Pause (ms)'] ?? 0).toFixed(2)
    const leakVal = Number(r['Leak (B/cycle)']).toFixed(2)
    const scoreVal = r['Memory Score (B)']
    return `| **${ r.Rank }** | ${ engineName } | \`${ nodeVal }\` | \`${ tickVal }\` | \`${ minorGc }\` | \`${ gcPause }\` | \`${ leakVal }\` | \`${ scoreVal }\` | \`${ r.Ratio }\` |`
  })
  .join('\n')

// const byName = new Map(rows.map((r) => [r.Engine, r]))
const mostFrequentGc = [...rows].sort(
  (a, b) => Number(b['Minor GC (count)'] ?? 0) - Number(a['Minor GC (count)'] ?? 0)
)[0]
const longestGcPause = [...rows].sort(
  (a, b) => Number(b['GC Pause (ms)'] ?? 0) - Number(a['GC Pause (ms)'] ?? 0)
)[0]

const formatGcExample = (row) =>
  `${ row.Engine }: \`${ row['Minor GC (count)'] ?? 0 }× / ${ Number(row['GC Pause (ms)'] ?? 0).toFixed(2) } ms\``

const asciiDiagram = [
  '```text',
  '================================================================================',
  '  ТОПОЛОГИЯ ТЕСТОВ ПАМЯТИ (3 НЕЗАВИСИМЫХ СЦЕНАРИЯ В ИЗОЛИРОВАННЫХ V8-ПРОЦЕССАХ)',
  '================================================================================',
  '',
  '  Обозначения:',
  '    S(x)     — сигнал-источник (source)',
  '    C(x)     — вычисляемый узел (computed)',
  '    E(eff)   — эффект-наблюдатель (effect)',
  '    ─→       — ребро зависимости (потребитель читает источник)',
  '    ──X      — вызов dispose() / отписка и удаление ребра',
  '',
  '  ------------------------------------------------------------------------------',
  '  1. GRAPH FOOTPRINT — статический вес одного узла [ Node (B) ]',
  '     Масштаб: 2 500 цепочек × 4 узла = 10 000 узлов в куче одновременно',
  '',
  '       S(s) ─→ C(c1) ─→ C(c2) ─→ E(eff)   (× 2 500)',
  '',
  '     Формула: (Heap_после − Heap_до) / 10 000  [после двойного global.gc()]',
  '     Смысл:   Насколько компактны сами объекты узлов и списки подписчиков',
  '              (интрузивные связные списки против Set / Map и замыканий).',
  '',
  '  ------------------------------------------------------------------------------',
  '  2. TICK CHURN — давление на Young Generation за 1 батч [ Tick Alloc (B) ]',
  '     Масштаб: 1 граф с ромбовидными связями × 5 000 батч-обновлений (без fib)',
  '',
  '       S(a) ─┬─→ C(c1) ─┬─→ C(c2) ─┬─→ C(c3) ─┬─→ C(c4) ─┬─→ C(c5) ─→ E(eff)',
  '             │          │          │          │          │',
  '       S(b) ─┘          │          │          │          │',
  '         │              │          │          │          │',
  '         │              └──────────┼──────────┼──────────┘',
  '         │                         ▲          │',
  '         └─────────────────────────┼──────────┘',
  '       (а также прямые рёбра: S(a) ─→ C(c3), S(b) ─→ C(c4))',
  '',
  '     Формула: (Heap_после − Heap_до) / 5 000 − Baseline  [до вызова GC]',
  '     Смысл:   Плодит ли планировщик временные массивы, очереди и замыкания',
  '              на каждый чих или переиспользует внутренние структуры.',
  '',
  '  ------------------------------------------------------------------------------',
  '  3. MOUNT / DISPOSE — утечки при динамическом монтировании [ Leak (B/cycle) ]',
  '     Масштаб: 2 000 циклов создания и уничтожения подграфа на живых корнях',
  '',
  '       S(rootA) ─┬─→ C(c) ─→ E(eff)   ──▶   S(rootA) ──X C(c) ──X E(eff)',
  '       S(rootB) ─┘                          S(rootB) ──X',
  '',
  '     Формула: (Heap_после − Heap_до) / 2 000  [после двойного global.gc()]',
  '     Смысл:   Остаются ли «висячие» ссылки или пустые слоты в массивах',
  '              подписчиков корневых сигналов после размонтирования виджета.',
  '',
  '================================================================================',
  '  ИТОГОВЫЙ ИНДЕКС:  Memory Score (B) = 10 × Node (B) + Tick Alloc (B)',
  '  (Суммарный след типичного 10-узлового виджета + стоимость 1 его обновления)',
  '================================================================================',
  '```',
].join('\n')

const markdown = `# reactive-memory-benchmark

Воспроизводимый бенчмарк потребления памяти, давления на сборщик мусора V8 (Young Generation) и утечек при динамическом монтировании/уничтожении графа для **Реактивных движков** в изолированных процессах Node.js (\`--expose-gc\`).

![Reactive Engines Memory Benchmark](./results/last-benchmark.png)

## 1. Результаты последнего прогона

* **Дата замера:** \`${ data.timestamp }\`
* **Среда выполнения:** Node.js \`${ data.nodeVersion }\` (\`${ data.platform }\`), \`${ data.cpuModel }\`
* **Масштаб тестов:** \`${ data.graphNodes.toLocaleString('ru-RU') }\` узлов (Footprint) | \`${ data.tickIterations.toLocaleString('ru-RU') }\` тиков (Churn) | \`${ data.mountCycles.toLocaleString('ru-RU') }\` циклов mount/dispose (Leaks)

${ tableHeader }
${ tableRows }

## 2. Методология и устройство тестов

${ asciiDiagram }

### Как интерпретировать метрики памяти

* **\`Node (B)\` — статический вес одного реактивного узла** после двойного \`global.gc()\` (на графе из \`${ data.graphNodes.toLocaleString('ru-RU') }\` узлов). **Показывает, насколько компактны внутренние структуры движка** (интрузивные списки против \`Set\`/\`Map\` и замыканий).
* **\`Tick Alloc (B)\` — чистые временные аллокации за 1 батч-тик** в Young Generation кучи V8 (за вычетом базового следа \`baseline\`). **Отражает, создаёт ли движок очереди, массивы уведомлений или замыкания на каждый тик.**
* **\`Minor GC\` и \`GC Pause (ms)\` — количество срабатываний и суммарное время пауз сборщика мусора V8** (\`PerformanceObserver\` с \`entryTypes: ['gc']\`) на стресс-прогоне из \`${ (data.gcStressIterations ?? 50000).toLocaleString('ru-RU') }\` тиков (без принудительных \`global.gc()\`). **Показывает реальный характер «пилы» памяти:** короткоживущие однопоколенческие объекты (например, у ${ formatGcExample(mostFrequentGc) }) быстро заполняют Young Generation, но почти бесплатно выметаются *Scavenger*, тогда как задержка ссылок в долгоживущих структурах (например, у ${ formatGcExample(longestGcPause) }) резко увеличивает суммарное время пауз GC.
* **\`Leak (B/cycle)\` — остаточная память после \`${ data.mountCycles.toLocaleString('ru-RU') }\` циклов создания и уничтожения динамического подграфа**, подписанного на долгоживущие корневые сигналы. **Значения \`≤ 1.00 B/cycle\` говорят о чистой отписке без висячих ссылок.**
* **\`Memory Score (B)\`** — композитный индекс (\`10 × Node (B) + Tick Alloc (B)\`), отражающий суммарный след типового 10-узлового виджета и одного его обновления (меньше — лучше).

## 3. Запуск стенда (\`bench.sh\`)

\`\`\`bash
bash bench.sh
\`\`\`

### Поддерживаемые флаги

| Флаг | Описание |
| :--- | :--- |
| \`--install\` | Обнуляет \`node_modules\` и переустанавливает зависимости по версиям из \`package.json\` / \`package-lock.json\`. |
| \`--update\` | Удаляет \`node_modules\` и \`package-lock.json\`, загружает самые свежие версии (\`@latest\`) из npm и обновляет \`package.json\`. |
| \`--local\` | Подключает локальную сборку \`@pravosleva/reactive-engine\` из \`~/projects/reactive-engine/dist\` через симлинк. |
`

fs.writeFileSync(readmePath, markdown)
console.log('Корневой ./README.md успешно обновлён!')
