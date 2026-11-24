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
  '| Rank | Engine | Node (B) | Tick Alloc (B) | Leak (B/cycle) | Memory Score (B) | Ratio |',
  '| :---: | :--- | :---: | :---: | :---: | :---: | :---: |',
].join('\n')

const tableRows = rows
  .map((r) => {
    const isFirst = r.Rank === 1
    const label = r.Version ? `${ r.Engine } \`${ r.Version }\`` : r.Engine
    const engineName = isFirst ? `**${ label }**` : label
    const nodeVal = r['Node (B)']
    const tickVal = r['Tick Alloc (B)']
    const leakVal = Number(r['Leak (B/cycle)']).toFixed(2)
    const scoreVal = r['Memory Score (B)']
    return `| **${ r.Rank }** | ${ engineName } | \`${ nodeVal }\` | \`${ tickVal }\` | \`${ leakVal }\` | \`${ scoreVal }\` | \`${ r.Ratio }\` |`
  })
  .join('\n')

const asciiDiagram = [
  '```text',
  '================================================================================',
  '  ЧТО ИМЕННО ПРОВЕРЯЕТ РЕАКТИВНЫЙ КОЛЛАЙДЕР ПАМЯТИ (3 НЕЗАВИСИМЫХ СЦЕНАРИЯ)',
  '================================================================================',
  '',
  '  1. GRAPH FOOTPRINT — статический вес одного узла [ Node (B) ]',
  '  ----------------------------------------------------------------------------',
  '     2 500 независимых цепочек × 4 узла = 10 000 узлов в памяти одновременно:',
  '',
  '       [Signal] ──▶ [Computed 1] ──▶ [Computed 2] ──▶ [Effect]   (× 2 500)',
  '',
  '     Замер:  (Heap_после - Heap_до) / 10 000   [после двойного global.gc()]',
  '     Смысл:  Насколько компактны сами объекты узлов и списки подписчиков',
  '             (интрузивные связные списки против Set / Map и замыканий).',
  '',
  '',
  '  2. TICK CHURN — давление на Young Generation за 1 батч [ Tick Alloc (B) ]',
  '  ----------------------------------------------------------------------------',
  '     Один 10-узловой граф обновляется в батче 5 000 раз подряд (без fib и .map):',
  '',
  '       batch(() => { a = i + 2; b = i + 3 })',
  '         │',
  '         ├──▶ [a] ──┬──▶ [c1] ──▶ [c2] ──▶ [c3] ──▶ [c4] ──▶ [c5] ──▶ [Effect]',
  '         └──▶ [b] ──┘              │        ▲        ▲        ▲',
  '                                   └────────┴────────┴────────┘ (ромбы)',
  '',
  '     Замер:  (Heap_после - Heap_до) / 5 000 - Baseline   [до вызова GC]',
  '     Смысл:  Плодит ли планировщик временные массивы, очереди и замыкания',
  '             на каждый чих или переиспользует внутренние структуры.',
  '',
  '',
  '  3. MOUNT / DISPOSE — утечки при динамическом монтировании [ Leak (B/cycle) ]',
  '  ----------------------------------------------------------------------------',
  '     2 000 циклов подключения и уничтожения подграфа к долгоживущим корням:',
  '',
  '       [Root A] ──┐   ╭ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ╮',
  '                  ├──▶│  [Computed] ──▶ [Effect]  ──▶ dispose() │  (× 2 000)',
  '       [Root B] ──┘   ╰ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ╯',
  '',
  '     Замер:  (Heap_после - Heap_до) / 2 000   [после двойного global.gc()]',
  '     Смысл:  Остаются ли «висячие» ссылки или пустые слоты в массивах',
  '             подписчиков корневых сигналов после размонтирования виджета.',
  '',
  '================================================================================',
  '  ИТОГОВЫЙ ИНДЕКС:  Memory Score (B) = 10 × Node (B) + Tick Alloc (B)',
  '  (Суммарный след типичного 10-узлового виджета + стоимость 1 его обновления)',
  '================================================================================',
  '```',
].join('\n')

const markdown = `# reactive-memory-benchmark

Воспроизводимый бенчмарк потребления памяти, давления на сборщик мусора V8 (Young Generation) и утечек при динамическом монтировании/уничтожении графа для **10 реактивных движков** в изолированных процессах Node.js (\`--expose-gc\`).

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

* **\`Node (B)\` — статический вес одного реактивного узла** после двойного \`global.gc()\` (на графе из \`10 000\` узлов: \`2 500\` сигналов → \`5 000\` computed → \`2 500\` эффектов). **Показывает, насколько компактны внутренние структуры движка** (интрузивные списки против \`Set\`/\`Map\` и замыканий).
* **\`Tick Alloc (B)\` — чистые временные аллокации за 1 батч-тик** в Young Generation кучи V8 (за вычетом базового следа \`baseline\`). **Отражает, создаёт ли движок очереди, массивы уведомлений или замыкания на каждый тик.**
* **\`Leak (B/cycle)\` — остаточная память после \`2 000\` циклов создания и уничтожения динамического подграфа**, подписанного на долгоживущие корневые сигналы. **Значения \`≤ 1.00 B/cycle\` говорят о чистой отписке без висячих ссылок.**
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
console.log('📝 Корневой ./README.md успешно обновлён!')
