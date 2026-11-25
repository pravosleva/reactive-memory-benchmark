import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import * as enginePkg from '@pravosleva/reactive-engine'

const { ReactiveEngine } = enginePkg

function forceGc() {
  if (typeof global.gc === 'function') {
    global.gc()
    global.gc()
  }
}

function getPackageVersion(pkgName) {
  if (!pkgName) return ''
  try {
    const pkgPath = path.join(process.cwd(), 'node_modules', ...pkgName.split('/'), 'package.json')
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    return pkg.version ? `v${ pkg.version }` : ''
  } catch {
    return ''
  }
}

function measureTickBaseline(iterations) {
  let sink = 0
  const dummyTick = (i) => {
    sink += (i + 1) * 2
  }
  for (let i = 0; i < 500; i++) dummyTick(i)

  let minAlloc = Infinity
  for (let s = 0; s < 3; s++) {
    forceGc()
    const before = process.memoryUsage().heapUsed
    for (let i = 0; i < iterations; i++) dummyTick(i)
    const after = process.memoryUsage().heapUsed
    const perIter = Math.max(0, (after - before) / iterations)
    if (perIter < minAlloc) minAlloc = perIter
  }
  assert.ok(sink > 0)
  return minAlloc
}

function measureMemoryProfile(name, scenarios) {
  const { buildStaticGraph, setupTickGraph, runMountDisposeCycle } = scenarios

  // --------------------------------------------------------------------------
  // 1. Graph Footprint: 10 000 реактивных узлов (2500 sig + 5000 comp + 2500 eff)
  // --------------------------------------------------------------------------
  const CHAINS = 2500
  const NODES_PER_CHAIN = 4
  const TOTAL_NODES = CHAINS * NODES_PER_CHAIN

  // Прогрев фабрик перед замером памяти
  const warmupRetain = buildStaticGraph(100)
  assert.ok(warmupRetain.length > 0)
  warmupRetain.length = 0

  forceGc()
  const heapBeforeGraph = process.memoryUsage().heapUsed
  const retainedGraph = buildStaticGraph(CHAINS)
  forceGc()
  const heapAfterGraph = process.memoryUsage().heapUsed
  assert.ok(retainedGraph.length > 0)

  const bytesPerNode = Math.max(0, (heapAfterGraph - heapBeforeGraph) / TOTAL_NODES)
  // Освобождаем статический граф перед следующим тестом
  retainedGraph.length = 0
  forceGc()

  // --------------------------------------------------------------------------
  // 2. Tick Churn: временные аллокации за 1 батч-тик на 10-узловом графе
  // --------------------------------------------------------------------------
  const tickCtrl = setupTickGraph()
  tickCtrl.step(0)
  assert.equal(tickCtrl.readSink(), 14, `[${ name }] Неверная контрольная сумма tick-графа`)

  for (let i = 0; i < 500; i++) {
    tickCtrl.step(i)
  }

  const TICK_ITERS = 5000
  const baselineTickAlloc = measureTickBaseline(TICK_ITERS)
  let bestTickAlloc = Infinity

  for (let s = 0; s < 3; s++) {
    forceGc()
    const before = process.memoryUsage().heapUsed
    for (let i = 0; i < TICK_ITERS; i++) {
      tickCtrl.step(i)
    }
    const after = process.memoryUsage().heapUsed
    const netPerTick = Math.max(0, (after - before) / TICK_ITERS - baselineTickAlloc)
    if (netPerTick < bestTickAlloc) bestTickAlloc = netPerTick
  }

  if (typeof tickCtrl.dispose === 'function') tickCtrl.dispose()
  forceGc()

  // --------------------------------------------------------------------------
  // 3. Mount / Dispose: утечка подписок на корневых сигналах за 2 000 циклов
  // --------------------------------------------------------------------------
  const MOUNT_CYCLES = 2000
  runMountDisposeCycle(50) // прогрев

  forceGc()
  const heapBeforeMount = process.memoryUsage().heapUsed
  runMountDisposeCycle(MOUNT_CYCLES)
  forceGc()
  const heapAfterMount = process.memoryUsage().heapUsed

  const leakPerCycle = Math.max(0, (heapAfterMount - heapBeforeMount) / MOUNT_CYCLES)

  // Композитный индекс: вес 10 узлов графа + 1 батч-тик (меньше = компактнее)
  const memoryScore = bytesPerNode * 10 + bestTickAlloc

  return {
    Engine: name,
    'Node (B)': Number(bytesPerNode.toFixed(1)),
    'Tick Alloc (B)': Number(bestTickAlloc.toFixed(1)),
    'Leak (B/cycle)': Number(leakPerCycle.toFixed(2)),
    'Memory Score (B)': Number(memoryScore.toFixed(1)),
  }
}

// ============================================================================
// Реестр 10 реактивных движков
// ============================================================================
const ENGINES = [
  {
    id: 'reactive-engine',
    pkg: '@pravosleva/reactive-engine',
    name: '@pravosleva/reactive-engine',
    run: async () =>
      measureMemoryProfile('@pravosleva/reactive-engine', {
        buildStaticGraph: (chains) => {
          const engine = new ReactiveEngine()
          const keep = [engine]
          let sink = 0
          for (let i = 0; i < chains; i++) {
            const s = engine.signal(i)
            const c1 = engine.computed(() => s.value + 1)
            const c2 = engine.computed(() => c1.value * 2)
            const e = engine.effect(() => {
              sink += c2.value
            })
            keep.push(s, c1, c2, e)
          }
          assert.ok(sink >= 0)
          return keep
        },
        setupTickGraph: () => {
          const engine = new ReactiveEngine()
          const a = engine.signal(0)
          const b = engine.signal(0)
          const c1 = engine.computed(() => a.value + b.value)
          const c2 = engine.computed(() => c1.value * 2)
          const c3 = engine.computed(() => c2.value + a.value)
          const c4 = engine.computed(() => c3.value - b.value)
          const c5 = engine.computed(() => c1.value + c4.value)
          let sink = 0
          const stop = engine.effect(() => {
            sink = c5.value
          })
          return {
            readSink: () => sink,
            step: (i) => {
              engine.batch(() => {
                a.value = i + 2
                b.value = i + 3
              })
            },
            dispose: () => {
              if (typeof stop === 'function') stop()
            },
          }
        },
        runMountDisposeCycle: (cycles) => {
          const engine = new ReactiveEngine()
          const rootA = engine.signal(1)
          const rootB = engine.signal(2)
          let sink = 0
          for (let i = 0; i < cycles; i++) {
            const c = engine.computed(() => rootA.value + rootB.value + i)
            const stop = engine.effect(() => {
              sink += c.value
            })
            rootA.value = i
            if (typeof stop === 'function') stop()
            else if (stop && typeof stop.dispose === 'function') stop.dispose()
          }
          assert.ok(sink > 0)
        },
      }),
  },
  {
    id: 'vue',
    pkg: '@vue/reactivity',
    name: '@vue/reactivity',
    run: async () => {
      const { ref, computed, effect, effectScope } = await import('@vue/reactivity')
      return measureMemoryProfile('@vue/reactivity', {
        buildStaticGraph: (chains) => {
          const keep = []
          let sink = 0
          for (let i = 0; i < chains; i++) {
            const s = ref(i)
            const c1 = computed(() => s.value + 1)
            const c2 = computed(() => c1.value * 2)
            const e = effect(() => {
              sink += c2.value
            })
            keep.push(s, c1, c2, e)
          }
          assert.ok(sink >= 0)
          return keep
        },
        setupTickGraph: () => {
          const scope = effectScope()
          let a, b, c5
          let sink = 0
          const queue = new Set()
          const flush = () => {
            for (const job of queue) {
              queue.delete(job)
              job()
            }
          }
          scope.run(() => {
            a = ref(0)
            b = ref(0)
            const c1 = computed(() => a.value + b.value)
            const c2 = computed(() => c1.value * 2)
            const c3 = computed(() => c2.value + a.value)
            const c4 = computed(() => c3.value - b.value)
            c5 = computed(() => c1.value + c4.value)
            const runner = effect(
              () => {
                sink = c5.value
              },
              { scheduler: () => queue.add(runner) }
            )
          })
          return {
            readSink: () => sink,
            step: (i) => {
              a.value = i + 2
              b.value = i + 3
              flush()
            },
            dispose: () => scope.stop(),
          }
        },
        runMountDisposeCycle: (cycles) => {
          const rootA = ref(1)
          const rootB = ref(2)
          let sink = 0
          for (let i = 0; i < cycles; i++) {
            const scope = effectScope()
            scope.run(() => {
              const c = computed(() => rootA.value + rootB.value + i)
              effect(() => {
                sink += c.value
              })
            })
            rootA.value = i
            scope.stop()
          }
          assert.ok(sink > 0)
        },
      })
    },
  },
  {
    id: 'angular',
    pkg: '@angular/core',
    name: '@angular/core (Signals)',
    run: async () => {
      const { createSignal, createComputed, createWatch, setActiveConsumer } = await import(
        '@angular/core/primitives/signals'
      )
      return measureMemoryProfile('@angular/core (Signals)', {
        buildStaticGraph: (chains) => {
          const keep = []
          let sink = 0
          for (let i = 0; i < chains; i++) {
            const [s, setS] = createSignal(i)
            const c1 = createComputed(() => s() + 1)
            const c2 = createComputed(() => c1() * 2)
            const w = createWatch(
              () => {
                sink += c2()
              },
              () => { },
              true
            )
            w.run()
            keep.push(s, setS, c1, c2, w)
          }
          assert.ok(sink >= 0)
          return keep
        },
        setupTickGraph: () => {
          const queue = new Set()
          const flush = () => {
            for (const w of queue) {
              queue.delete(w)
              w.run()
            }
          }
          const [a, setA] = createSignal(0)
          const [b, setB] = createSignal(0)
          const c1 = createComputed(() => a() + b())
          const c2 = createComputed(() => c1() * 2)
          const c3 = createComputed(() => c2() + a())
          const c4 = createComputed(() => c3() - b())
          const c5 = createComputed(() => c1() + c4())
          let sink = 0
          const w = createWatch(
            () => {
              sink = c5()
            },
            () => queue.add(w),
            true
          )
          const prev = setActiveConsumer(null)
          try {
            w.run()
          } finally {
            setActiveConsumer(prev)
          }
          return {
            readSink: () => sink,
            step: (i) => {
              setA(i + 2)
              setB(i + 3)
              flush()
            },
            dispose: () => w.destroy(),
          }
        },
        runMountDisposeCycle: (cycles) => {
          const [rootA, setRootA] = createSignal(1)
          const [rootB] = createSignal(2)
          let sink = 0
          for (let i = 0; i < cycles; i++) {
            const c = createComputed(() => rootA() + rootB() + i)
            const w = createWatch(
              () => {
                sink += c()
              },
              () => { },
              true
            )
            w.run()
            setRootA(i)
            w.run()
            w.destroy()
          }
          assert.ok(sink > 0)
        },
      })
    },
  },
  {
    id: 'mobx',
    pkg: 'mobx',
    name: 'MobX',
    run: async () => {
      const mobxPkg = await import('mobx')
      const { observable, computed, autorun, runInAction, configure } = mobxPkg.default ?? mobxPkg
      if (typeof configure === 'function') configure({ enforceActions: 'never' })
      return measureMemoryProfile('MobX', {
        buildStaticGraph: (chains) => {
          const keep = []
          let sink = 0
          for (let i = 0; i < chains; i++) {
            const s = observable.box(i)
            const c1 = computed(() => s.get() + 1)
            const c2 = computed(() => c1.get() * 2)
            const d = autorun(() => {
              sink += c2.get()
            })
            keep.push(s, c1, c2, d)
          }
          assert.ok(sink >= 0)
          return keep
        },
        setupTickGraph: () => {
          const a = observable.box(0)
          const b = observable.box(0)
          const c1 = computed(() => a.get() + b.get())
          const c2 = computed(() => c1.get() * 2)
          const c3 = computed(() => c2.get() + a.get())
          const c4 = computed(() => c3.get() - b.get())
          const c5 = computed(() => c1.get() + c4.get())
          let sink = 0
          const dispose = autorun(() => {
            sink = c5.get()
          })
          return {
            readSink: () => sink,
            step: (i) => {
              runInAction(() => {
                a.set(i + 2)
                b.set(i + 3)
              })
            },
            dispose,
          }
        },
        runMountDisposeCycle: (cycles) => {
          const rootA = observable.box(1)
          const rootB = observable.box(2)
          let sink = 0
          for (let i = 0; i < cycles; i++) {
            const c = computed(() => rootA.get() + rootB.get() + i)
            const dispose = autorun(() => {
              sink += c.get()
            })
            rootA.set(i)
            dispose()
          }
          assert.ok(sink > 0)
        },
      })
    },
  },
  {
    id: 'mol',
    pkg: 'mol_wire_lib',
    name: '$mol ($mol_wire_solo)',
    run: async () => {
      const molWirePkg = await import('mol_wire_lib')
      const Solo = molWirePkg.default?.$mol_wire_solo ?? molWirePkg.$mol_wire_solo
      const Fiber = molWirePkg.default?.$mol_wire_fiber ?? molWirePkg.$mol_wire_fiber
      const mem = (proto, key) => {
        const desc = Object.getOwnPropertyDescriptor(proto, key)
        Object.defineProperty(proto, key, Solo(proto, key, desc))
      }

      return measureMemoryProfile('$mol ($mol_wire_solo)', {
        buildStaticGraph: (chains) => {
          let sink = 0
          class Chain {
            constructor(init) {
              this._init = init
            }
            s(next = this._init) {
              return next
            }
            c1() {
              return this.s() + 1
            }
            c2() {
              return this.c1() * 2
            }
            e() {
              sink += this.c2()
            }
          }
          mem(Chain.prototype, 's')
          mem(Chain.prototype, 'c1')
          mem(Chain.prototype, 'c2')
          mem(Chain.prototype, 'e')

          const keep = []
          for (let i = 0; i < chains; i++) {
            const node = new Chain(i)
            node.e()
            keep.push(node)
          }
          if (typeof Fiber?.sync === 'function') Fiber.sync()
          assert.ok(sink >= 0)
          return keep
        },
        setupTickGraph: () => {
          let sink = 0
          class TickGraph {
            a(next = 0) { return next }
            b(next = 0) { return next }
            c1() { return this.a() + this.b() }
            c2() { return this.c1() * 2 }
            c3() { return this.c2() + this.a() }
            c4() { return this.c3() - this.b() }
            c5() { return this.c1() + this.c4() }
            e() { sink = this.c5() }
          }
          for (const k of ['a', 'b', 'c1', 'c2', 'c3', 'c4', 'c5', 'e']) {
            mem(TickGraph.prototype, k)
          }
          const g = new TickGraph()
          g.e()
          if (typeof Fiber?.sync === 'function') Fiber.sync()
          return {
            readSink: () => sink,
            step: (i) => {
              g.a(i + 2)
              g.b(i + 3)
              g.e()
              if (typeof Fiber?.sync === 'function') Fiber.sync()
            },
          }
        },
        runMountDisposeCycle: (cycles) => {
          let sink = 0
          class Root {
            rootA(next = 1) { return next }
            rootB(next = 2) { return next }
          }
          mem(Root.prototype, 'rootA')
          mem(Root.prototype, 'rootB')

          class SubGraph {
            constructor(root, offset) {
              this.root = root
              this.offset = offset
            }
            c() { return this.root.rootA() + this.root.rootB() + this.offset }
            e() { sink += this.c() }
          }
          mem(SubGraph.prototype, 'c')
          mem(SubGraph.prototype, 'e')

          const root = new Root()
          for (let i = 0; i < cycles; i++) {
            const sub = new SubGraph(root, i)
            sub.e()
            root.rootA(i)
            sub.e()
            sub.e.destructor?.()
            sub.c.destructor?.()
            if (typeof Fiber?.sync === 'function') Fiber.sync()
          }
          assert.ok(sink > 0)
        },
      })
    },
  },
  {
    id: 'solid2',
    pkg: '@solidjs/signals',
    name: 'SolidJS 2 (@solidjs/signals)',
    run: async () => {
      const solidMod = await import('@solidjs/signals')
      const { createSignal, createMemo, createEffect, createRoot } = solidMod
      const doFlush = solidMod.flush ?? solidMod.flushSync ?? (() => { })
      return measureMemoryProfile('SolidJS 2 (@solidjs/signals)', {
        buildStaticGraph: (chains) => {
          const keep = []
          let sink = 0
          createRoot((dispose) => {
            keep.push(dispose)
            for (let i = 0; i < chains; i++) {
              const [s, setS] = createSignal(i)
              const c1 = createMemo(() => s() + 1)
              const c2 = createMemo(() => c1() * 2)
              createEffect(c2, (v) => {
                sink += v
              })
              keep.push(s, setS, c1, c2)
            }
          })
          doFlush()
          assert.ok(sink >= 0)
          return keep
        },
        setupTickGraph: () => {
          const [a, setA] = createSignal(0)
          const [b, setB] = createSignal(0)
          let sink = 0
          let disposeRoot
          createRoot((dispose) => {
            disposeRoot = dispose
            const c1 = createMemo(() => a() + b())
            const c2 = createMemo(() => c1() * 2)
            const c3 = createMemo(() => c2() + a())
            const c4 = createMemo(() => c3() - b())
            const c5 = createMemo(() => c1() + c4())
            createEffect(c5, (v) => {
              sink = v
            })
          })
          doFlush()
          return {
            readSink: () => sink,
            step: (i) => {
              setA(i + 2)
              setB(i + 3)
              doFlush()
            },
            dispose: disposeRoot,
          }
        },
        runMountDisposeCycle: (cycles) => {
          const [rootA, setRootA] = createSignal(1)
          const [rootB] = createSignal(2)
          let sink = 0
          for (let i = 0; i < cycles; i++) {
            let disposeRoot
            createRoot((dispose) => {
              disposeRoot = dispose
              const c = createMemo(() => rootA() + rootB() + i)
              createEffect(c, (v) => {
                sink += v
              })
            })
            doFlush()
            setRootA(i)
            doFlush()
            if (typeof disposeRoot === 'function') disposeRoot()
          }
          assert.ok(sink > 0)
        },
      })
    },
  },
  {
    id: 'alien-signals',
    pkg: 'alien-signals',
    name: 'alien-signals',
    run: async () => {
      const { signal, computed, effect, effectScope, startBatch, endBatch } = await import(
        'alien-signals'
      )
      return measureMemoryProfile('alien-signals', {
        buildStaticGraph: (chains) => {
          const keep = []
          let sink = 0
          for (let i = 0; i < chains; i++) {
            const s = signal(i)
            const c1 = computed(() => s() + 1)
            const c2 = computed(() => c1() * 2)
            const stop = effect(() => {
              sink += c2()
            })
            keep.push(s, c1, c2, stop)
          }
          assert.ok(sink >= 0)
          return keep
        },
        setupTickGraph: () => {
          const a = signal(0)
          const b = signal(0)
          const c1 = computed(() => a() + b())
          const c2 = computed(() => c1() * 2)
          const c3 = computed(() => c2() + a())
          const c4 = computed(() => c3() - b())
          const c5 = computed(() => c1() + c4())
          let sink = 0
          const stop = effect(() => {
            sink = c5()
          })
          return {
            readSink: () => sink,
            step: (i) => {
              startBatch()
              a(i + 2)
              b(i + 3)
              endBatch()
            },
            dispose: stop,
          }
        },
        runMountDisposeCycle: (cycles) => {
          const rootA = signal(1)
          const rootB = signal(2)
          let sink = 0
          for (let i = 0; i < cycles; i++) {
            const stopScope =
              typeof effectScope === 'function'
                ? effectScope(() => {
                  const c = computed(() => rootA() + rootB() + i)
                  effect(() => {
                    sink += c()
                  })
                })
                : (() => {
                  const c = computed(() => rootA() + rootB() + i)
                  return effect(() => {
                    sink += c()
                  })
                })()
            rootA(i)
            if (typeof stopScope === 'function') stopScope()
          }
          assert.ok(sink > 0)
        },
      })
    },
  },
  {
    id: 'preact-signals',
    pkg: '@preact/signals-core',
    name: '@preact/signals-core',
    run: async () => {
      const { signal, computed, effect, batch } = await import('@preact/signals-core')
      return measureMemoryProfile('@preact/signals-core', {
        buildStaticGraph: (chains) => {
          const keep = []
          let sink = 0
          for (let i = 0; i < chains; i++) {
            const s = signal(i)
            const c1 = computed(() => s.value + 1)
            const c2 = computed(() => c1.value * 2)
            const dispose = effect(() => {
              sink += c2.value
            })
            keep.push(s, c1, c2, dispose)
          }
          assert.ok(sink >= 0)
          return keep
        },
        setupTickGraph: () => {
          const a = signal(0)
          const b = signal(0)
          const c1 = computed(() => a.value + b.value)
          const c2 = computed(() => c1.value * 2)
          const c3 = computed(() => c2.value + a.value)
          const c4 = computed(() => c3.value - b.value)
          const c5 = computed(() => c1.value + c4.value)
          let sink = 0
          const dispose = effect(() => {
            sink = c5.value
          })
          return {
            readSink: () => sink,
            step: (i) => {
              batch(() => {
                a.value = i + 2
                b.value = i + 3
              })
            },
            dispose,
          }
        },
        runMountDisposeCycle: (cycles) => {
          const rootA = signal(1)
          const rootB = signal(2)
          let sink = 0
          for (let i = 0; i < cycles; i++) {
            const c = computed(() => rootA.value + rootB.value + i)
            const dispose = effect(() => {
              sink += c.value
            })
            rootA.value = i
            dispose()
          }
          assert.ok(sink > 0)
        },
      })
    },
  },
  {
    id: 'reatom',
    pkg: '@reatom/core',
    name: 'Reatom (@reatom/core)',
    run: async () => {
      const { atom, computed, notify } = await import('@reatom/core')
      return measureMemoryProfile('Reatom (@reatom/core)', {
        buildStaticGraph: (chains) => {
          const keep = []
          let sink = 0
          for (let i = 0; i < chains; i++) {
            const s = atom(i)
            const c1 = computed(() => s() + 1)
            const c2 = computed(() => c1() * 2)
            const e = computed(() => {
              sink += c2()
              return sink
            })
            const unsub = e.subscribe()
            keep.push(s, c1, c2, e, unsub)
          }
          assert.ok(sink >= 0)
          return keep
        },
        setupTickGraph: () => {
          const a = atom(0)
          const b = atom(0)
          const c1 = computed(() => a() + b())
          const c2 = computed(() => c1() * 2)
          const c3 = computed(() => c2() + a())
          const c4 = computed(() => c3() - b())
          const c5 = computed(() => c1() + c4())
          let sink = 0
          const e = computed(() => {
            sink = c5()
            return sink
          })
          const unsub = e.subscribe()
          return {
            readSink: () => sink,
            step: (i) => {
              a.set(i + 2)
              b.set(i + 3)
              if (typeof notify === 'function') notify()
            },
            dispose: unsub,
          }
        },
        runMountDisposeCycle: (cycles) => {
          const rootA = atom(1)
          const rootB = atom(2)
          let sink = 0
          for (let i = 0; i < cycles; i++) {
            const c = computed(() => rootA() + rootB() + i)
            const e = computed(() => {
              sink += c()
              return sink
            })
            const unsub = e.subscribe()
            rootA.set(i)
            if (typeof notify === 'function') notify()
            if (typeof unsub === 'function') unsub()
          }
          assert.ok(sink > 0)
        },
      })
    },
  },
  {
    id: 'effector',
    pkg: 'effector',
    name: 'Effector',
    run: async () => {
      const effPkg = await import('effector')
      const { createStore, createEvent, combine, clearNode } = effPkg.default ?? effPkg
      return measureMemoryProfile('Effector', {
        buildStaticGraph: (chains) => {
          const keep = []
          let sink = 0
          for (let i = 0; i < chains; i++) {
            const s = createStore(i)
            const c1 = s.map((v) => v + 1)
            const c2 = c1.map((v) => v * 2)
            const unwatch = c2.watch((v) => {
              sink += v
            })
            keep.push(s, c1, c2, unwatch)
          }
          assert.ok(sink >= 0)
          return keep
        },
        setupTickGraph: () => {
          const tick = createEvent()
          const $a = createStore(0).on(tick, (_, p) => p.a)
          const $b = createStore(0).on(tick, (_, p) => p.b)
          const $c1 = combine($a, $b, (a, b) => a + b)
          const $c2 = $c1.map((v) => v * 2)
          const $c3 = combine($c2, $a, (c2, a) => c2 + a)
          const $c4 = combine($c3, $b, (c3, b) => c3 - b)
          const $c5 = combine($c1, $c4, (c1, c4) => c1 + c4)
          let sink = 0
          const unwatch = $c5.watch((v) => {
            sink = v
          })
          return {
            readSink: () => sink,
            step: (i) => {
              tick({ a: i + 2, b: i + 3 })
            },
            dispose: () => {
              unwatch()
              if (typeof clearNode === 'function') {
                clearNode($c5)
                clearNode($a)
                clearNode($b)
              }
            },
          }
        },
        runMountDisposeCycle: (cycles) => {
          const setRootA = createEvent()
          const $rootA = createStore(1).on(setRootA, (_, v) => v)
          const $rootB = createStore(2)
          let sink = 0
          for (let i = 0; i < cycles; i++) {
            const $c = combine($rootA, $rootB, (a, b) => a + b + i)
            const unwatch = $c.watch((v) => {
              sink += v
            })
            setRootA(i)
            unwatch()
            if (typeof clearNode === 'function') clearNode($c)
          }
          assert.ok(sink > 0)
        },
      })
    },
  },
]
// ============================================================================
// Режим дочернего воркера (--only=) vs Оркестратор
// ============================================================================
const onlyArg = process.argv.find((a) => a.startsWith('--only='))
if (onlyArg) {
  const targetId = onlyArg.slice('--only='.length)
  const entry = ENGINES.find((e) => e.id === targetId)
  if (!entry) {
    process.stderr.write(`Unknown engine id: ${ targetId }\n`)
    process.exit(1)
  }
  try {
    const result = await entry.run()
    result.Version = getPackageVersion(entry.pkg)
    process.stdout.write(`__RESULT__:${ JSON.stringify(result) }\n`)
    process.exit(0)
  } catch (err) {
    process.stderr.write(`${ err.message }\n`)
    process.exit(1)
  }
} else {
  const scriptPath = fileURLToPath(import.meta.url)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  const isTTY = Boolean(process.stdout.isTTY)
  const runWorkerWithSpinner = (engine, index, total) =>
    new Promise((resolve) => {
      const prefix = `   [${ index + 1 }/${ total }] ${ engine.name }`
      const startedAt = performance.now()
      let frameIdx = 0
      let timer = null
      if (isTTY) {
        timer = setInterval(() => {
          const sec = ((performance.now() - startedAt) / 1000).toFixed(1)
          const frame = FRAMES[frameIdx++ % FRAMES.length]
          process.stdout.write(`\r\x1b[K${ prefix } ${ frame } (${ sec }s)`)
        }, 80)
      } else {
        process.stdout.write(`${ prefix }... `)
      }
      execFile(
        process.execPath,
        ['--expose-gc', scriptPath, `--only=${ engine.id }`],
        { encoding: 'utf8' },
        (err, stdout, stderr) => {
          if (timer) clearInterval(timer)
          if (isTTY) process.stdout.write('\r\x1b[K')
          if (err) {
            const errMsg = stderr?.toString().trim() || err.message
            console.log(`${ prefix } ⛔ пропущен (${ errMsg })`)
            resolve(null)
            return
          }
          const markerLine = stdout
            .split('\n')
            .find((line) => line.startsWith('__RESULT__:'))
          if (!markerLine) {
            console.log(`${ prefix } ⛔ пропущен (нет строки результата от воркера)`)
            resolve(null)
            return
          }
          try {
            const parsed = JSON.parse(markerLine.slice('__RESULT__:'.length))
            console.log(
              `${ prefix } ✔ (Node: ${ parsed['Node (B)'] } B | Tick: ${ parsed['Tick Alloc (B)'] } B | Leak: ${ parsed['Leak (B/cycle)'] } B)`
            )
            resolve(parsed)
          } catch (parseErr) {
            console.log(`${ prefix } ⛔ ошибка JSON (${ parseErr.message })`)
            resolve(null)
          }
        }
      )
    })
  const results = []
  for (let i = 0; i < ENGINES.length; i++) {
    const res = await runWorkerWithSpinner(ENGINES[i], i, ENGINES.length)
    if (res) results.push(res)
    if (i < ENGINES.length - 1) {
      if (isTTY) process.stdout.write('   ❄️  Пауза для стабилизации V8 (0.5s)...')
      await sleep(500)
      if (isTTY) process.stdout.write('\r\x1b[K')
    }
  }
  if (results.length === 0) {
    console.error('\n❌ Ни один движок не прошёл замер.')
    process.exit(1)
  }
  results.sort((a, b) => a['Memory Score (B)'] - b['Memory Score (B)'])
  const bestScore = results.at(0)['Memory Score (B)']
  const rankedResults = results.map((row, idx) => ({
    Rank: idx + 1,
    ...row,
    Ratio: `${ (row['Memory Score (B)'] / Math.max(bestScore, 1)).toFixed(2) }×`,
  }))
  console.log('\n🧠 Сравнение потребления памяти в изолированных процессах V8 (--expose-gc):\n')
  console.table(rankedResults)
  const reportData = {
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
    platform: `${ os.platform() } ${ os.arch() }`,
    cpuModel: os.cpus().at(0)?.model?.trim() || 'Unknown CPU',
    graphNodes: 10000,
    tickIterations: 5000,
    mountCycles: 2000,
    isolatedProcesses: true,
    results: rankedResults,
  }
  const resultsDir = new URL('./results/', import.meta.url)
  fs.mkdirSync(resultsDir, { recursive: true })
  fs.writeFileSync(new URL('./last-benchmark.json', resultsDir), JSON.stringify(reportData, null, 2))
  process.exit(0)
}